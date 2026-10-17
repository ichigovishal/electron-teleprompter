#!/usr/bin/env python3
"""
Local speech-to-text daemon for Electron Teleprompter.

Captures the default microphone with sounddevice, transcribes speech with
faster-whisper (fully offline), and streams recognized words over a local
WebSocket so the app can auto-scroll without sending audio to a cloud STT.

Server -> client messages (JSON):
    {"type": "status", "status": "ready", "model": "<name>"}
    {"type": "final",  "transcript": "...", "words": ["a", "b", ...]}
    {"type": "error",  "message": "..."}
"""

import argparse
import json
import os
import queue
import signal
import sys
import threading
import time

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel
from websockets.sync.server import serve

SAMPLE_RATE = 16000
BLOCK_SECONDS = 0.1
MIN_CHUNK_SECONDS = 0.3


def resample_linear( x, src_rate, dst_rate ):
	"""Cheap linear resample; fine for speech features fed to Whisper."""
	if src_rate == dst_rate or x.size == 0:
		return x
	n_out = int( round( x.size * dst_rate / src_rate ) )
	if n_out == x.size:
		return x
	indices = np.arange( n_out ) * src_rate / dst_rate
	i0 = indices.astype( np.int32 )
	frac = indices - i0
	i1 = np.minimum( i0 + 1, x.size - 1 )
	return ( x[i0] * ( 1.0 - frac ) + x[i1] * frac ).astype( np.float32 )


def main():
	parser = argparse.ArgumentParser( description="Local faster-whisper STT daemon." )
	parser.add_argument( "--host", default="127.0.0.1" )
	parser.add_argument( "--port", type=int, default=8766 )
	parser.add_argument( "--model", default="base" )
	parser.add_argument( "--language", default="en" )
	parser.add_argument( "--device", default=None, help="sounddevice input index or name (default: system default input)" )
	parser.add_argument( "--silence-ms", type=float, default=900.0, help="silence after speech that ends a chunk" )
	parser.add_argument( "--max-chunk-ms", type=float, default=8000.0, help="force-transcribe long utterances" )
	parser.add_argument( "--threshold", type=float, default=0.008, help="RMS energy that counts as speech" )
	parser.add_argument( "--verbose", action="store_true" )
	args = parser.parse_args()
	if args.device is not None and str( args.device ).isdigit():
		args.device = int( args.device )

	print( f"[stt] loading model '{args.model}'…", flush=True )
	model = WhisperModel( args.model, device="cpu", compute_type="int8" )
	print( f"[stt] model ready", flush=True )

	audio = { "buf": [], "speech": False, "silent_ms": 0.0, "lock": threading.Lock() }
	jobs = queue.Queue( maxsize=8 )
	client = { "conn": None, "lock": threading.Lock() }
	stop_flag = threading.Event()


	def broadcast( payload ):
		with client["lock"]:
			conn = client["conn"]
		if conn is None:
			return
		try:
			conn.send( json.dumps( payload ) )
		except Exception:
			pass


	def on_block( indata, frames, _time_info, _status ):
		with audio["lock"]:
			block = indata[:, 0]
			if device_rate != SAMPLE_RATE:
				block = resample_linear( block, device_rate, SAMPLE_RATE )
			audio["buf"].append( block )
			rms = float( np.sqrt( np.mean( block**2 ) ) ) if block.size else 0.0
			if rms >= args.threshold:
				audio["speech"] = True
				audio["silent_ms"] = 0.0
			elif audio["speech"]:
				audio["silent_ms"] += BLOCK_SECONDS * 1000.0

			total_ms = sum( len( b ) for b in audio["buf"] ) / SAMPLE_RATE * 1000.0
			if audio["speech"] and ( audio["silent_ms"] >= args.silence_ms or total_ms >= args.max_chunk_ms ):
				buf = audio["buf"]
				audio["buf"] = []
				audio["speech"] = False
				audio["silent_ms"] = 0.0
				if total_ms >= MIN_CHUNK_SECONDS * 1000.0:
					try:
						jobs.put( buf, block=False )
					except queue.Full:
						if args.verbose:
							print( "[stt] dropped chunk (queue full)", flush=True )
		if args.verbose and rms > args.threshold:
			print( f"[stt] speech rms={rms:.4f}", flush=True )


	def transcribe_worker():
		while not stop_flag.is_set():
			try:
				buf = jobs.get( timeout=1.0 )
			except queue.Empty:
				continue
			try:
				samples = np.concatenate( buf ) if len( buf ) > 1 else buf[0]
				if len( samples ) < int( SAMPLE_RATE * MIN_CHUNK_SECONDS ):
					continue
				segments, _info = model.transcribe(
					samples,
					language=args.language,
					word_timestamps=True,
					vad_filter=True,
					condition_on_previous_text=False,
					beam_size=5
				)
				words = []
				for seg in segments:
					for w in ( seg.words or [] ):
						words.append( w.word )
				if words:
					broadcast( { "type": "final", "transcript": " ".join( words ), "words": words } )
					if args.verbose:
						print( f"[stt] :: {' '.join( words )}", flush=True )
			except Exception as err:  # noqa: BLE001
				broadcast( { "type": "error", "message": str( err ) } )
				print( f"[stt] transcribe error: {err}", flush=True )


	stream = None
	device_rate = SAMPLE_RATE


	def open_stream():
		nonlocal stream, device_rate
		try:
			device = args.device
			if device is None:
				device = sd.default.device[0]
			if device is None or device == -1:
				raise RuntimeError( "no default audio input device" )
			info = sd.query_devices( device=device )
			device_rate = int( info["default_samplerate"] )
			stream = sd.InputStream(
				samplerate=device_rate,
				channels=1,
				dtype="float32",
				blocksize=int( device_rate * BLOCK_SECONDS ),
				device=device,
				callback=on_block
			)
			stream.start()
			return True
		except Exception as err:  # noqa: BLE001
			broadcast( { "type": "error", "message": f"mic error: {err}" } )
			print( f"[stt] mic error: {err}", flush=True )
			return False


	def handler( conn ):
		with client["lock"]:
			client["conn"] = conn
		try:
			broadcast( { "type": "status", "status": "ready", "model": args.model } )
			for _msg in conn:
				pass  # consume messages so disconnects are detected
		finally:
			with client["lock"]:
				if client["conn"] is conn:
					client["conn"] = None


	worker = threading.Thread( target=transcribe_worker, daemon=True )
	worker.start()

	if not open_stream():
		sys.exit( 1 )

	print( f"[stt] ready ws://{args.host}:{args.port}", flush=True )

	# Free the model (and the mic) as soon as the launching process is gone,
	# even if it never sends us a signal.
	initial_ppid = os.getppid()

	def watch_parent():
		while not stop_flag.is_set():
			if initial_ppid > 1 and os.getppid() != initial_ppid:
				print( "[stt] parent process gone — exiting", flush=True )
				stop_flag.set()
				os._exit( 0 )
			time.sleep( 1 )

	def handle_term( _signum, _frame ):
		print( "[stt] shutdown signal received", flush=True )
		stop_flag.set()
		raise SystemExit( 0 )

	try:
		signal.signal( signal.SIGTERM, handle_term )
	except ValueError:
		pass  # not on the main thread — fine

	print( f"[stt] guarding parent pid {initial_ppid}", flush=True )
	threading.Thread( target=watch_parent, daemon=True ).start()

	try:
		with serve( handler, args.host, args.port, ping_interval=10 ) as server:
			server.serve_forever()
	except OSError as err:
		print( f"[stt] PORT_IN_USE: {err}", flush=True )
		sys.exit( 0 )
	finally:
		stop_flag.set()
		if stream is not None:
			try:
				stream.stop()
				stream.close()
			except Exception:  # noqa: BLE001
				pass


if __name__ == "__main__":
	main()
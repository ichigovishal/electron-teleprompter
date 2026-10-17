// Local faster-whisper auto-scroll: a local STT daemon (src/stt-daemon.py)
// transcribes the microphone and streams recognized words over a local
// WebSocket. Words are aligned against the rendered script and smooth-scrolled.

import {
	buildWordIndex,
	scrollToWord,
	cancelScroll,
	setScrollSpeed,
	getScrollSpeed,
	SCROLL_SPEED_MIN,
	SCROLL_SPEED_MAX,
	SCROLL_SPEED_DEFAULT,
	SCROLL_SPEED_STEP
} from "./word-index.js";
import { createAligner } from "./aligner.js";

const STT_URL = "ws://127.0.0.1:8766";

let activeCtx = null;

export function isActive() {
	return activeCtx !== null;
}

export async function startAutoScroll( { scriptEl, onStatus, onScroll, startIndex } ) {
	if ( activeCtx ) {
		throw new Error( "Auto-scroll already active." );
	}
	if ( !scriptEl ) {
		throw new Error( "scriptEl is required." );
	}

	const wordIndex = buildWordIndex( scriptEl );
	const aligner = createAligner( wordIndex.words );

	// Optionally begin from a user-chosen point instead of the top of the script.
	const start = Number.isInteger( startIndex ) ? Math.max( 0, Math.min( wordIndex.words.length - 1, startIndex ) ) : 0;
	if ( start > 0 ) {
		aligner.setPosition( start );
		scrollToWord( start, wordIndex.ranges, { smooth: false } );
	}

	const ws = new WebSocket( STT_URL );

	await new Promise( ( resolve, reject ) => {
		const timeout = setTimeout( () => reject( new Error( "STT daemon unreachable. Restart the app so it can start the transcription service." ) ), 5000 );
		ws.addEventListener( "open", () => {
			clearTimeout( timeout );
			resolve();
		}, { once: true } );
		ws.addEventListener( "error", () => {
			clearTimeout( timeout );
			reject( new Error( "Could not connect to the local transcription service." ) );
		}, { once: true } );
	} );

	ws.addEventListener( "message", ( event ) => {
		let data;
		try {
			data = JSON.parse( event.data );
		} catch {
			return;
		}
		if ( data.type === "status" ) {
			onStatus?.( { type: "model", model: data.model ?? "", state: data.status ?? "" } );
		} else if ( data.type === "final" && data.words?.length ) {
			const prevPos = aligner.currentPosition();
			for ( const w of data.words ) {
				aligner.addRecognized( w );
			}
			const newPos = aligner.step();
			const moved = newPos !== prevPos;
			console.log( "[auto-scroll] transcript:", data.transcript, "-> position", newPos );
			if ( moved ) {
				onScroll?.( newPos, wordIndex.ranges );
			}
			onStatus?.( { type: "transcript", wordIdx: newPos, transcript: data.transcript, moved } );
		} else if ( data.type === "error" ) {
			onStatus?.( { type: "error", error: data.message } );
		}
	} );

	ws.addEventListener( "error", ( err ) => {
		onStatus?.( { type: "error", error: err?.message || "STT websocket error" } );
	} );

	ws.addEventListener( "close", () => {
		onStatus?.( { type: "closed" } );
	} );

	activeCtx = { ws, wordIndex, aligner };
	onStatus?.( { type: "started", wordCount: wordIndex.words.length } );

	return {
		getPosition: () => aligner.currentPosition(),
		wordIndex
	};
}

// Move the active session to a new position (e.g. the user re-marked the start
// point). Clears the pending scroll so the viewport snaps to the new word.
export function setAutoScrollPosition( index ) {
	if ( !activeCtx ) return;
	const { aligner, wordIndex } = activeCtx;
	if ( !Number.isInteger( index ) ) return;
	const clamped = Math.max( 0, Math.min( wordIndex.words.length - 1, index ) );
	aligner.setPosition( clamped );
	scrollToWord( clamped, wordIndex.ranges, { smooth: false } );
}

export async function stopAutoScroll() {
	if ( !activeCtx ) return;
	const { ws } = activeCtx;
	activeCtx = null;
	cancelScroll();
	try {
		ws.close();
	} catch ( err ) {
		console.warn( "[auto-scroll] ws close error", err );
	}
}

export {
	scrollToWord,
	cancelScroll,
	setScrollSpeed,
	getScrollSpeed,
	SCROLL_SPEED_MIN,
	SCROLL_SPEED_MAX,
	SCROLL_SPEED_DEFAULT,
	SCROLL_SPEED_STEP
};

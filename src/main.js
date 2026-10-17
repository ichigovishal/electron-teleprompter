import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import chokidar from "chokidar";
import stateFactory from "./utils/state.js";
import { convertMarkdown, readAndConvertMarkdown, readRawMarkdown } from "./utils/content.js";
import { buildMenus } from "./menus.js";

const __dirname = import.meta.dirname; // eslint-disable-line n/no-unsupported-features/node-builtins

const MAX_RECENT_FILES = 10;

const defaultConfig = {
	width: 800,
	height: 600,
	fontSize: 3,
	opacity: 0.07,
	mirrored: false,
	recentFiles: [],
	autoScrollSpeed: 1
};

const stateManager = stateFactory( defaultConfig );
let watcher;
let watcherPaused = false;

let currentFontSize = defaultConfig.fontSize;
let currentOpacity = defaultConfig.opacity;
let currentMirrored = defaultConfig.mirrored;
let currentAutoScrollSpeed = defaultConfig.autoScrollSpeed;
let recentFiles = [];
let currentFilePath = null;
let hasUnsavedChanges = false;
let isClosing = false;
let moduleOpenScriptFile = null;
let moduleOpenScriptFileDialog = null;
let sttProcess = null;

function startSttDaemon() {
	const pythonBin = process.env.STT_PYTHON || path.join( os.homedir(), "video-tools", "venv", "bin", "python" );
	const daemonScript = path.join( __dirname, "stt-daemon.py" );
	const args = [ daemonScript ];
	if ( process.env.STT_DEVICE ) {
		args.push( "--device", process.env.STT_DEVICE );
	}
	sttProcess = spawn( pythonBin, args, { stdio: [ "ignore", "pipe", "pipe" ] } );
	sttProcess.stdout.on( "data", d => console.log( "[stt]", String( d ).trim() ) );
	sttProcess.stderr.on( "data", d => console.error( "[stt]", String( d ).trim() ) );
	sttProcess.on( "exit", ( code ) => {
		console.log( `[stt] daemon exited (${ code })` );
		sttProcess = null;
	} );
}

function addRecentFile( filePath ) {
	recentFiles = [ filePath, ...recentFiles.filter( f => f !== filePath ) ].slice( 0, MAX_RECENT_FILES );
}

const saveState = async ( win ) => {
	const position = win.getPosition();
	const size = win.getSize();

	stateManager.writeAppState( {
		width: size[0],
		height: size[1],
		x: position[0],
		y: position[1],
		fontSize: currentFontSize,
		opacity: currentOpacity,
		mirrored: currentMirrored,
		recentFiles,
		autoScrollSpeed: currentAutoScrollSpeed
	} );
};

const createWindow = ( state ) => {
	const win = new BrowserWindow( {
		width: state.width,
		height: state.height,
		...( state.x != null && state.y != null ? { x: state.x, y: state.y } : {} ),
		center: state.x == null,
		webPreferences: {
			nodeIntegration: false,
			sandbox: false,
			preload: path.join( __dirname, "client", "teleprompter-preload.mjs" )
		},
		transparent: true,
		frame: false
	} );

	win.loadFile( path.join( __dirname, "client", "teleprompter.html" ) );

	win.webContents.on( "console-message", ( _event, details ) => {
		const message = details && typeof details === "object" ? details.message : details;
		console.log( "[renderer]", message );
	} );

	win.webContents.on( "did-finish-load", () => {
		win.webContents.send( "fontSize", state.fontSize || defaultConfig.fontSize );
		win.webContents.send( "opacity", state.opacity ?? defaultConfig.opacity );
		win.webContents.send( "mirrored", state.mirrored || false );
		win.webContents.send( "autoScrollSpeed", state.autoScrollSpeed ?? defaultConfig.autoScrollSpeed );
	} );

	win.on( "close", async ( event ) => {
		if ( isClosing ) {
			await saveState( win );
			return;
		}
		if ( hasUnsavedChanges ) {
			event.preventDefault();
			const result = await dialog.showMessageBox( win, {
				type: "warning",
				buttons: [ "Save", "Don't Save", "Cancel" ],
				defaultId: 0,
				cancelId: 2,
				message: "You have unsaved changes.",
				detail: "Do you want to save your changes before closing?"
			} );
			if ( result.response === 0 ) {
				// Save — tell renderer to save, then we'll close via saveAndClose IPC
				win.webContents.send( "requestSaveBeforeClose" );
			} else if ( result.response === 1 ) {
				// Don't Save — close without saving
				isClosing = true;
				win.close();
			}
			// Cancel (2) — do nothing, window stays open
		} else {
			await saveState( win );
		}
	} );

	async function watchScriptFile( scriptFile ) {
		if ( watcher ) {
			await watcher.close();
		}
		watcherPaused = false;
		watcher = chokidar.watch( scriptFile );
		watcher.on( "change", async () => {
			if ( watcherPaused ) return;
			const md = await readAndConvertMarkdown( scriptFile );
			win.webContents.send( "content", md );
		} );
	}

	async function openScriptFile( scriptFile ) {
		if ( hasUnsavedChanges ) {
			const result = await dialog.showMessageBox( win, {
				type: "warning",
				buttons: [ "Save", "Don't Save", "Cancel" ],
				defaultId: 0,
				cancelId: 2,
				message: "You have unsaved changes.",
				detail: "Do you want to save your changes before opening a new file?"
			} );
			if ( result.response === 0 ) {
				// Tell renderer to save, then return — user can re-open after saving
				win.webContents.send( "menuSave" );
				return null;
			} else if ( result.response === 2 ) {
				return null;
			}
			// Don't Save — proceed
			hasUnsavedChanges = false;
		}

		const md = await readAndConvertMarkdown( scriptFile );
		if ( md ) {
			currentFilePath = scriptFile;
			win.webContents.send( "content", md );
			addRecentFile( scriptFile );
			watchScriptFile( scriptFile );
			buildMenus( win, openScriptFile, recentFiles, openScriptFileDialog );
		}
		return md;
	}

	async function openScriptFileDialog() {
		const results = await dialog.showOpenDialog( win, {
			properties: [ "openFile" ],
			filters: [
				{ name: "Markdown", extensions: [ "md", "txt" ] },
				{ name: "All Files", extensions: [ "*" ] }
			]
		} );
		if ( !results.canceled ) {
			return openScriptFile( results.filePaths[0] );
		}
		return null;
	}

	moduleOpenScriptFile = openScriptFile;
	moduleOpenScriptFileDialog = openScriptFileDialog;
	buildMenus( win, openScriptFile, recentFiles, openScriptFileDialog );

	return { win, openScriptFile };
};

app.whenReady().then( async () => {
	const state = await stateManager.readAppState();
	currentFontSize = state.fontSize || defaultConfig.fontSize;
	currentOpacity = state.opacity ?? defaultConfig.opacity;
	currentMirrored = state.mirrored || false;
	recentFiles = state.recentFiles || [];
	currentAutoScrollSpeed = state.autoScrollSpeed ?? defaultConfig.autoScrollSpeed;

	startSttDaemon();
	app.on( "will-quit", () => {
		if ( sttProcess ) {
			sttProcess.kill();
			sttProcess = null;
		}
	} );

	ipcMain.on( "fontSize", ( _event, size ) => {
		currentFontSize = size;
	} );

	ipcMain.on( "opacity", ( _event, value ) => {
		currentOpacity = value;
	} );

	ipcMain.on( "mirrored", ( _event, value ) => {
		currentMirrored = value;
	} );

	ipcMain.on( "autoScrollSpeed", ( _event, value ) => {
		if ( Number.isFinite( value ) ) {
			currentAutoScrollSpeed = value;
		}
	} );

	const { win, openScriptFile } = createWindow( state );

	ipcMain.on( "resizeWindow", ( _event, width, height ) => {
		win.setSize( width, height, false );
	} );

	ipcMain.on( "menuOpen", () => {
		if ( moduleOpenScriptFileDialog ) {
			moduleOpenScriptFileDialog();
		}
	} );

	// Editor IPC handlers
	ipcMain.on( "requestRawMarkdown", async () => {
		if ( currentFilePath ) {
			const raw = await readRawMarkdown( currentFilePath );
			win.webContents.send( "rawMarkdown", raw, currentFilePath );
		} else {
			win.webContents.send( "rawMarkdown", "", null );
		}
	} );

	async function saveFileAs( content ) {
		const result = await dialog.showSaveDialog( win, {
			defaultPath: currentFilePath || "untitled.md",
			filters: [
				{ name: "Markdown", extensions: [ "md", "txt" ] },
				{ name: "All Files", extensions: [ "*" ] }
			]
		} );
		if ( !result.canceled && result.filePath ) {
			try {
				await fs.writeFile( result.filePath, content, { encoding: "utf-8" } );
				currentFilePath = result.filePath;
				hasUnsavedChanges = false;
				addRecentFile( result.filePath );
				buildMenus( win, moduleOpenScriptFile, recentFiles, moduleOpenScriptFileDialog );
				const md = await readAndConvertMarkdown( result.filePath );
				win.webContents.send( "content", md );
				win.webContents.send( "saveResult", true, result.filePath );
			} catch ( err ) {
				console.log( "Save As error:", err );
				win.webContents.send( "saveResult", false, null );
			}
		}
	}

	ipcMain.on( "saveFile", async ( _event, content ) => {
		if ( currentFilePath ) {
			try {
				await fs.writeFile( currentFilePath, content, { encoding: "utf-8" } );
				hasUnsavedChanges = false;
				const md = await readAndConvertMarkdown( currentFilePath );
				win.webContents.send( "content", md );
				win.webContents.send( "saveResult", true, currentFilePath );
			} catch ( err ) {
				console.log( "Save error:", err );
				win.webContents.send( "saveResult", false, currentFilePath );
			}
		} else {
			await saveFileAs( content );
		}
	} );

	ipcMain.on( "saveFileAs", async ( _event, content ) => {
		await saveFileAs( content );
	} );

	ipcMain.on( "editorDirty", ( _event, dirty ) => {
		hasUnsavedChanges = dirty;
	} );

	ipcMain.on( "pauseWatcher", () => {
		watcherPaused = true;
	} );

	ipcMain.on( "resumeWatcher", () => {
		watcherPaused = false;
	} );

	ipcMain.on( "previewMarkdown", async ( _event, markdown ) => {
		const html = await convertMarkdown( markdown );
		win.webContents.send( "content", html );
	} );

	ipcMain.on( "reloadContent", async () => {
		if ( currentFilePath ) {
			const md = await readAndConvertMarkdown( currentFilePath );
			if ( md ) {
				win.webContents.send( "content", md );
			}
		}
	} );

	ipcMain.on( "saveAndClose", async () => {
		isClosing = true;
		await saveState( win );
		win.close();
	} );

	// Auto-load most recent file on startup
	if ( recentFiles.length > 0 ) {
		win.webContents.on( "did-finish-load", () => {
			openScriptFile( recentFiles[0] );
		} );
	}
} );

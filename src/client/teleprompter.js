import {
	startAutoScroll,
	stopAutoScroll,
	scrollToWord,
	setAutoScrollPosition,
	cancelScroll,
	setScrollSpeed,
	SCROLL_SPEED_MIN,
	SCROLL_SPEED_MAX,
	SCROLL_SPEED_DEFAULT,
	SCROLL_SPEED_STEP
} from "./auto-scroll.js";
import { buildWordIndex, indexAtAnchor, READING_ANCHOR_RATIO } from "./word-index.js";

let scriptIndex = 0;
const md = document.getElementById( "md" );

const DEFAULT_FONT_SIZE = 3;
const FONT_SIZE_STEP = 0.25;
const MIN_FONT_SIZE = 1;
const MAX_FONT_SIZE = 8;
let fontSize = DEFAULT_FONT_SIZE;

function setFontSize( size, save = true ) {
	fontSize = Math.min( MAX_FONT_SIZE, Math.max( MIN_FONT_SIZE, size ) );
	document.body.style.fontSize = `${ fontSize }em`;
	if ( save ) {
		window.electron.saveFontSize( fontSize );
	}
}

window.electron.onFontSize( ( size ) => {
	setFontSize( size, false );
} );

const DEFAULT_OPACITY = 0.07;
const OPACITY_STEP = 0.05;
let opacity = DEFAULT_OPACITY;

function setOpacity( value, save = true ) {
	opacity = Math.min( 1, Math.max( 0, Math.round( value * 100 ) / 100 ) );
	document.body.style.backgroundColor = `rgba(0, 0, 0, ${ opacity })`;
	if ( save ) {
		window.electron.saveOpacity( opacity );
	}
}

window.electron.onOpacity( ( value ) => {
	setOpacity( value, false );
} );

let mirrored = false;

function setMirrored( value, save = true ) {
	mirrored = value;
	document.body.style.transform = mirrored ? "scaleX(-1)" : "";
	if ( save ) {
		window.electron.saveMirrored( mirrored );
	}
}

window.electron.onMirrored( ( value ) => {
	setMirrored( value, false );
} );

function jumpToSection( index ) {
	const url = location.href;
	location.href = "#" + index;
	history.replaceState( null, null, url );
}

// --- Editor mode state ---
let isEditMode = false;
let isDirty = false;
let isLoadingContent = false;
let isNewFile = false;
let isSaving = false;
let editorView = null;
let previewManuallyScrolled = false;
let pendingScrollToCursor = false;
let savedScrollY = 0;

const previewContainer = document.getElementById( "preview-container" );
const editorContainer = document.getElementById( "editor-container" );
const editorDiv = document.getElementById( "editor" );
const toolbarFilename = document.getElementById( "toolbar-filename" );
const toolbarDirty = document.getElementById( "toolbar-dirty" );
const btnOpen = document.getElementById( "btn-open" );
const btnSave = document.getElementById( "btn-save" );
const btnSaveAs = document.getElementById( "btn-save-as" );
const btnCancel = document.getElementById( "btn-cancel" );
const resizeHandle = document.getElementById( "resize-handle" );
const autoScrollIndicator = document.getElementById( "auto-scroll-indicator" );
const autoScrollAnchorLine = document.getElementById( "auto-scroll-anchor-line" );

// --- Auto-scroll state ---
let autoScrollActive = false;
let autoScrollStarting = false;
let lastManualScrollTs = 0;
let autoScrollSpeed = SCROLL_SPEED_DEFAULT;
let speedHintTimer = null;
// Word index the next auto-scroll session should begin from (0 = top of script).
let autoScrollStartIndex = 0;
let anchorLineTimer = null;
const MANUAL_SCROLL_GRACE_MS = 3000;
const SPEED_HINT_MS = 1500;
const ANCHOR_LINE_MS = 2500;

// Align the guide line with the reading anchor used when scrolling.
if ( autoScrollAnchorLine ) {
	autoScrollAnchorLine.style.top = `${ READING_ANCHOR_RATIO * 100 }%`;
}

// Track manual scrolling in preview mode
let ignoreNextScroll = false;
window.addEventListener( "scroll", () => {
	if ( isEditMode ) return;
	if ( ignoreNextScroll ) {
		ignoreNextScroll = false;
		return;
	}
	if ( window.scrollY > 0 ) {
		previewManuallyScrolled = true;
	}
} );

function noteManualScroll() {
	if ( autoScrollActive ) {
		lastManualScrollTs = Date.now();
		cancelScroll();
	}
}
window.addEventListener( "wheel", noteManualScroll, { passive: true } );
window.addEventListener( "mousedown", noteManualScroll );
const SCROLL_KEYS = new Set( [ "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " " ] );
document.addEventListener( "keydown", ( e ) => {
	if ( SCROLL_KEYS.has( e.key ) ) noteManualScroll();
}, true );

function scrollPreviewToCursorLine() {
	if ( !editorView || !md ) return;
	const cursorLine = window.EditorModule.getCursorLine( editorView );
	const totalLines = editorView.state.doc.lines;
	if ( totalLines <= 1 ) return;

	// Use cursor line ratio to scroll the preview to the same relative position
	const ratio = ( cursorLine - 1 ) / ( totalLines - 1 );
	const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
	if ( maxScroll > 0 ) {
		ignoreNextScroll = true;
		window.scrollTo( 0, Math.round( ratio * maxScroll ) );
	}
}

function setDirty( dirty ) {
	isDirty = dirty;
	window.electron.setEditorDirty( dirty );
	if ( toolbarDirty ) {
		toolbarDirty.classList.toggle( "hidden", !dirty );
	}
}

function showEditor() {
	previewContainer.classList.add( "hidden" );
	editorContainer.classList.remove( "hidden" );
	if ( resizeHandle ) resizeHandle.classList.add( "hidden" );
	document.body.style.backgroundColor = "#282c34";
	document.body.style.overflow = "hidden";
}

function showPreview() {
	editorContainer.classList.add( "hidden" );
	previewContainer.classList.remove( "hidden" );
	if ( resizeHandle ) resizeHandle.classList.remove( "hidden" );
	document.body.style.backgroundColor = `rgba(0, 0, 0, ${ opacity })`;
	document.body.style.overflow = "";
}

function enterEditMode() {
	if ( isEditMode ) return;
	if ( autoScrollActive || autoScrollStarting ) {
		stopAutoScrollSession();
	}
	savedScrollY = window.scrollY;
	isEditMode = true;

	window.electron.pauseWatcher();
	window.electron.requestRawMarkdown();
}

function loadEditorContent( content, filePath ) {
	const rawContent = content ?? "";

	showEditor();

	if ( toolbarFilename ) {
		toolbarFilename.textContent = filePath ? filePath.split( "/" ).pop() : "New file";
	}
	setDirty( false );

	isLoadingContent = true;
	if ( editorView ) {
		window.EditorModule.setEditorContent( editorView, rawContent );
	} else {
		editorView = window.EditorModule.createEditor( editorDiv, rawContent, () => {
			if ( !isDirty && !isLoadingContent ) {
				setDirty( true );
			}
		} );
	}
	isLoadingContent = false;
	editorView.focus();
}

window.electron.onRawMarkdown( ( content, filePath ) => {
	if ( !isEditMode ) return;
	loadEditorContent( content, filePath );
} );

function discardAndExitEditor() {
	if ( !isEditMode ) return;
	isEditMode = false;
	isNewFile = false;

	showPreview();
	setDirty( false );
	window.electron.resumeWatcher();
	window.electron.reloadContent();
}

function toggleEditMode() {
	if ( isEditMode ) {
		// Switch to preview without discarding — keep editor state intact
		isEditMode = false;
		pendingScrollToCursor = !previewManuallyScrolled;
		// Update preview with current editor content
		if ( editorView ) {
			const content = window.EditorModule.getEditorContent( editorView );
			window.electron.previewMarkdown( content );
		}
		showPreview();
	} else if ( editorView ) {
		if ( autoScrollActive || autoScrollStarting ) {
			stopAutoScrollSession();
		}
		// Save preview scroll position before switching to editor
		savedScrollY = window.scrollY;
		// Resume editing — just swap visibility back
		isEditMode = true;
		window.electron.pauseWatcher();
		showEditor();
		editorView.focus();
	} else {
		enterEditMode();
	}
}

function saveEditorContent() {
	if ( !editorView ) return;
	isSaving = true;
	const content = window.EditorModule.getEditorContent( editorView );
	if ( isNewFile ) {
		window.electron.saveFileAs( content );
	} else {
		window.electron.saveFile( content );
	}
}

function saveEditorContentAs() {
	if ( !editorView ) return;
	isSaving = true;
	const content = window.EditorModule.getEditorContent( editorView );
	window.electron.saveFileAs( content );
}

// Close coordination — save editor content then signal main to close
let pendingSaveAndClose = false;

// Listen for save result
window.electron.onSaveResult( ( success, filePath ) => {
	isSaving = false;
	if ( success ) {
		setDirty( false );
		isNewFile = false;
		if ( filePath && toolbarFilename ) {
			toolbarFilename.textContent = filePath.split( "/" ).pop();
		}
	}
	if ( pendingSaveAndClose ) {
		pendingSaveAndClose = false;
		window.electron.saveAndClose();
	}
} );

// Listen for toggle editor from menu
window.electron.onToggleEditor( toggleEditMode );

// New file — enter edit mode with empty content
window.electron.onNewFile( () => {
	if ( isDirty ) {
		const discard = confirm( "You have unsaved changes. Discard and create a new file?" );
		if ( !discard ) return;
	}
	isNewFile = true;
	isEditMode = true;
	window.electron.pauseWatcher();
	loadEditorContent( "", null );
} );

// Listen for menu save/save-as (works from editor or preview with pending edits)
window.electron.onMenuSave( () => {
	if ( isDirty ) {
		saveEditorContent();
	}
} );

window.electron.onMenuSaveAs( () => {
	if ( editorView ) {
		saveEditorContentAs();
	}
} );

window.electron.onRequestSaveBeforeClose( () => {
	if ( editorView && isDirty ) {
		pendingSaveAndClose = true;
		saveEditorContent();
	}
} );

// Toolbar buttons
if ( btnOpen ) {
	btnOpen.addEventListener( "click", () => window.electron.openFile() );
}
if ( btnSave ) {
	btnSave.addEventListener( "click", saveEditorContent );
}
if ( btnSaveAs ) {
	btnSaveAs.addEventListener( "click", saveEditorContentAs );
}
if ( btnCancel ) {
	btnCancel.addEventListener( "click", () => {
		if ( isDirty ) {
			const discard = confirm( "You have unsaved changes. Discard changes?" );
			if ( !discard ) return;
		}
		discardAndExitEditor();
	} );
}

// --- Keyboard handling ---
document.addEventListener( "keydown", ( event ) => {
	// Suppress teleprompter shortcuts when in edit mode
	if ( isEditMode ) return;

	if ( ( event.key === "ArrowDown" || event.key === "ArrowUp" ) && !( ( event.metaKey || event.ctrlKey ) && event.shiftKey ) ) {
		// Allow default scroll behavior, but track it
		previewManuallyScrolled = true;
	} else if ( event.key === "ArrowRight" ) {
		event.preventDefault();
		// Advance to next section
		const sections = document.getElementsByName( scriptIndex + 1 );
		if ( sections.length > 0 ) {
			scriptIndex++;
			previewManuallyScrolled = true;
			jumpToSection( scriptIndex );
		}
	} else if ( event.key === "ArrowLeft" ) {
		event.preventDefault();
		// Go back to previous section
		if ( scriptIndex > 0 ) {
			scriptIndex--;
			previewManuallyScrolled = true;
			jumpToSection( scriptIndex );
		}
	} else if ( ( event.metaKey || event.ctrlKey ) && !event.shiftKey && ( event.key === "=" || event.key === "+" ) ) {
		event.preventDefault();
		setFontSize( fontSize + FONT_SIZE_STEP );
	} else if ( ( event.metaKey || event.ctrlKey ) && !event.shiftKey && event.key === "-" ) {
		event.preventDefault();
		setFontSize( fontSize - FONT_SIZE_STEP );
	} else if ( ( event.metaKey || event.ctrlKey ) && !event.shiftKey && event.key === "0" ) {
		event.preventDefault();
		setFontSize( DEFAULT_FONT_SIZE );
	} else if ( ( event.metaKey || event.ctrlKey ) && event.key === "m" ) {
		event.preventDefault();
		setMirrored( !mirrored );
	} else if ( ( event.metaKey || event.ctrlKey ) && event.shiftKey && event.key === "ArrowUp" ) {
		event.preventDefault();
		setOpacity( opacity + OPACITY_STEP );
	} else if ( ( event.metaKey || event.ctrlKey ) && event.shiftKey && event.key === "ArrowDown" ) {
		event.preventDefault();
		setOpacity( opacity - OPACITY_STEP );
	} else if ( ( event.metaKey || event.ctrlKey ) && event.shiftKey && ( event.key === ")" || event.key === "0" ) ) {
		event.preventDefault();
		setOpacity( DEFAULT_OPACITY );
	}
} );

// Resize handle
if ( resizeHandle ) {
	resizeHandle.addEventListener( "mousedown", ( e ) => {
		e.preventDefault();
		const startX = e.screenX;
		const startY = e.screenY;
		const startWidth = window.outerWidth;
		const startHeight = window.outerHeight;

		function onMouseMove( moveEvent ) {
			const newWidth = Math.max( 200, startWidth + moveEvent.screenX - startX );
			const newHeight = Math.max( 150, startHeight + moveEvent.screenY - startY );
			window.electron.resizeWindow( newWidth, newHeight );
		}

		function onMouseUp() {
			document.removeEventListener( "mousemove", onMouseMove );
			document.removeEventListener( "mouseup", onMouseUp );
		}

		document.addEventListener( "mousemove", onMouseMove );
		document.addEventListener( "mouseup", onMouseUp );
	} );
}

// Handle content loaded from main process
window.electron.onContent( ( content ) => {
	if ( md ) {
		md.innerHTML = content;
		// New HTML invalidates the word index, so drop any captured start point.
		autoScrollStartIndex = 0;
		if ( autoScrollAnchorLine ) autoScrollAnchorLine.classList.add( "hidden" );
		if ( pendingScrollToCursor ) {
			pendingScrollToCursor = false;
			requestAnimationFrame( () => scrollPreviewToCursorLine() );
		} else if ( previewManuallyScrolled && !isSaving ) {
			// Restore saved scroll position after layout completes
			requestAnimationFrame( () => {
				ignoreNextScroll = true;
				window.scrollTo( 0, savedScrollY );
			} );
		} else if ( !isSaving ) {
			scriptIndex = 0;
			previewManuallyScrolled = false;
		}
	}
	// If in edit mode, reload the editor with the new file's raw markdown
	// (skip if the content update was triggered by our own save)
	if ( isEditMode && !isSaving ) {
		window.electron.requestRawMarkdown();
	}
	// Reloaded HTML invalidates the word index; stop auto-scroll if active.
	if ( autoScrollActive ) {
		stopAutoScrollSession();
	}
} );

// --- Auto-scroll toggle ---

function setIndicator( text, variant ) {
	if ( !autoScrollIndicator ) return;
	if ( !text ) {
		autoScrollIndicator.classList.add( "hidden" );
		autoScrollIndicator.textContent = "";
		return;
	}
	autoScrollIndicator.textContent = text;
	autoScrollIndicator.classList.remove( "hidden", "connecting", "error" );
	if ( variant ) autoScrollIndicator.classList.add( variant );
}

function handleAutoScrollPosition( wordIdx, ranges ) {
	if ( Date.now() - lastManualScrollTs < MANUAL_SCROLL_GRACE_MS ) return;
	scrollToWord( wordIdx, ranges );
}

// Briefly reveal the reading-anchor guide so the user can see where the
// captured start point landed.
function flashAnchorLine() {
	if ( !autoScrollAnchorLine ) return;
	autoScrollAnchorLine.classList.remove( "hidden" );
	if ( anchorLineTimer ) clearTimeout( anchorLineTimer );
	anchorLineTimer = setTimeout( () => {
		anchorLineTimer = null;
		autoScrollAnchorLine.classList.add( "hidden" );
	}, ANCHOR_LINE_MS );
}

// Capture the word currently sitting on the reading anchor as the point where
// the next auto-scroll session should begin.
function setAutoScrollStartHere() {
	if ( isEditMode ) {
		alert( "Exit the editor before setting the auto-scroll start point." );
		return;
	}
	if ( !md ) return;
	const { ranges } = buildWordIndex( md );
	const idx = indexAtAnchor( ranges );
	autoScrollStartIndex = idx;
	// Snap the marked word onto the anchor so the viewport and the aligner
	// agree about where "here" is when the session starts.
	scrollToWord( idx, ranges, { smooth: false } );
	flashAnchorLine();
	if ( autoScrollActive ) {
		setAutoScrollPosition( idx );
		showTransientHint( "Start point moved" );
	} else {
		showTransientHint( "Start point set" );
	}
}

function clearAutoScrollStart() {
	autoScrollStartIndex = 0;
	if ( autoScrollAnchorLine ) autoScrollAnchorLine.classList.add( "hidden" );
	showTransientHint( "Start point cleared" );
}

async function startAutoScrollSession() {
	if ( autoScrollActive || autoScrollStarting ) return;
	if ( isEditMode ) {
		alert( "Exit the editor before starting auto-scroll." );
		return;
	}
	autoScrollStarting = true;
	setIndicator( "Connecting…", "connecting" );
	try {
		await startAutoScroll( {
			scriptEl: md,
			startIndex: autoScrollStartIndex,
			onStatus: ( status ) => {
				if ( status.type === "closed" || status.type === "error" ) {
					if ( autoScrollActive ) stopAutoScrollSession();
				} else if ( status.type === "model" && autoScrollActive ) {
					setIndicator( `STT ${ status.model || "unknown" }\nListening` );
				}
			},
			onScroll: handleAutoScrollPosition
		} );
		autoScrollActive = true;
		autoScrollStarting = false;
		lastManualScrollTs = 0;
		setIndicator( "Listening" );
	} catch ( err ) {
		autoScrollStarting = false;
		console.error( "[auto-scroll] start failed", err );
		setIndicator( "Error", "error" );
		setTimeout( () => {
			if ( !autoScrollActive ) setIndicator( null );
		}, 3000 );
		alert( `Failed to start auto-scroll: ${ err.message }` );
	}
}

async function stopAutoScrollSession() {
	if ( !autoScrollActive && !autoScrollStarting ) return;
	autoScrollActive = false;
	autoScrollStarting = false;
	setIndicator( null );
	try {
		await stopAutoScroll();
	} catch ( err ) {
		console.warn( "[auto-scroll] stop error", err );
	}
}

function toggleAutoScrollSession() {
	if ( autoScrollActive || autoScrollStarting ) {
		stopAutoScrollSession();
	} else {
		startAutoScrollSession();
	}
}

if ( autoScrollIndicator ) {
	autoScrollIndicator.addEventListener( "click", () => {
		stopAutoScrollSession();
	} );
}

window.electron.onToggleAutoScroll( toggleAutoScrollSession );
window.electron.onMenuSetAutoScrollStart( setAutoScrollStartHere );
window.electron.onMenuClearAutoScrollStart( clearAutoScrollStart );

// --- Auto-scroll speed control ---

function applyAutoScrollSpeed( value, save = true ) {
	const clamped = Math.max( SCROLL_SPEED_MIN, Math.min( SCROLL_SPEED_MAX, value ) );
	autoScrollSpeed = Math.round( clamped * 100 ) / 100;
	setScrollSpeed( autoScrollSpeed );
	if ( save ) {
		window.electron.saveAutoScrollSpeed( autoScrollSpeed );
	}
}

function showTransientHint( text, durationMs ) {
	if ( !autoScrollIndicator ) return;
	autoScrollIndicator.textContent = text;
	autoScrollIndicator.classList.remove( "hidden", "connecting", "error" );
	if ( speedHintTimer ) clearTimeout( speedHintTimer );
	speedHintTimer = setTimeout( () => {
		speedHintTimer = null;
		if ( autoScrollActive ) {
			setIndicator( "Listening" );
		} else if ( autoScrollStarting ) {
			setIndicator( "Connecting…", "connecting" );
		} else {
			setIndicator( null );
		}
	}, durationMs );
}

function showSpeedHint() {
	const text = `Speed ${ autoScrollSpeed.toFixed( 2 ).replace( /\.?0+$/, "" ) }×`;
	showTransientHint( text, SPEED_HINT_MS );
}

function adjustAutoScrollSpeed( action ) {
	if ( action === "up" ) {
		applyAutoScrollSpeed( autoScrollSpeed + SCROLL_SPEED_STEP );
	} else if ( action === "down" ) {
		applyAutoScrollSpeed( autoScrollSpeed - SCROLL_SPEED_STEP );
	} else if ( action === "reset" ) {
		applyAutoScrollSpeed( SCROLL_SPEED_DEFAULT );
	} else {
		return;
	}
	showSpeedHint();
}

window.electron.onAutoScrollSpeed( ( value ) => {
	applyAutoScrollSpeed( value, false );
} );

window.electron.onMenuAdjustAutoScrollSpeed( adjustAutoScrollSpeed );

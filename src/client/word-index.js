// Word-position index for the rendered script.
// Walks text nodes inside a root element, splits into normalized words,
// and stores a DOM Range for each word so we can scroll to it later.

const NORMALIZE_REGEX = /[^\w']/g;

// Fraction of the viewport height where the "current" word sits while
// auto-scrolling (and therefore where the start point is captured from).
export const READING_ANCHOR_RATIO = 0.33;

function normalize( word ) {
	return word.toLowerCase().replace( NORMALIZE_REGEX, "" );
}

export function buildWordIndex( rootEl ) {
	const words = [];
	const ranges = [];
	if ( !rootEl ) return { words, ranges };

	const walker = document.createTreeWalker( rootEl, NodeFilter.SHOW_TEXT );
	const wordRegex = /\S+/g;
	let node;
	while ( ( node = walker.nextNode() ) ) {
		const text = node.nodeValue;
		let match;
		while ( ( match = wordRegex.exec( text ) ) !== null ) {
			const cleaned = normalize( match[0] );
			if ( !cleaned ) continue;
			const range = document.createRange();
			range.setStart( node, match.index );
			range.setEnd( node, match.index + match[0].length );
			words.push( cleaned );
			ranges.push( range );
		}
	}
	return { words, ranges };
}

// Find the index of the word closest to the reading anchor line
// (`anchorRatio` of the viewport height down from the top). Used to capture
// the current reading position as an auto-scroll start point. Ranges are in
// document order, so we can stop as soon as we pass the anchor.
export function indexAtAnchor( ranges, anchorRatio = READING_ANCHOR_RATIO ) {
	if ( !ranges || !ranges.length ) return 0;
	const anchorY = window.innerHeight * anchorRatio;
	let bestIndex = 0;
	let bestDist = Infinity;
	for ( let i = 0; i < ranges.length; i++ ) {
		const rect = ranges[i].getBoundingClientRect();
		if ( rect.width === 0 && rect.height === 0 ) continue;
		const dist = Math.abs( rect.top - anchorY );
		if ( dist < bestDist ) {
			bestDist = dist;
			bestIndex = i;
		}
		if ( rect.top > anchorY && bestDist < Infinity ) break;
	}
	return bestIndex;
}

// Smooth scroll using a critically-damped spring (Unity-style SmoothDamp).
// `smoothTime` is roughly the time-to-target in seconds; dividing by
// speedMultiplier lets the user dial auto-scroll responsiveness up or down.
// Velocity persists across target updates so successive transcripts blend into
// one continuous glide rather than a series of stop-starts.

const BASE_SMOOTH_TIME = 0.4;
const POSITION_THRESHOLD = 0.3;
const VELOCITY_THRESHOLD = 0.05;
const MAX_DT = 0.05;

let scrollTargetY = null;
let scrollPos = 0;
let scrollVel = 0;
let scrollAnimating = false;
let lastFrameTs = 0;
let speedMultiplier = 1;

export const SCROLL_SPEED_MIN = 0.25;
export const SCROLL_SPEED_MAX = 4;
export const SCROLL_SPEED_DEFAULT = 1;
export const SCROLL_SPEED_STEP = 0.1;

export function setScrollSpeed( value ) {
	if ( !Number.isFinite( value ) ) return;
	speedMultiplier = Math.max( SCROLL_SPEED_MIN, Math.min( SCROLL_SPEED_MAX, value ) );
}

export function getScrollSpeed() {
	return speedMultiplier;
}

function smoothDamp( current, target, velocity, smoothTime, dt ) {
	const omega = 2 / Math.max( 0.0001, smoothTime );
	const x = omega * dt;
	const exp = 1 / ( 1 + x + 0.48 * x * x + 0.235 * x * x * x );
	const change = current - target;
	const temp = ( velocity + omega * change ) * dt;
	const newVel = ( velocity - omega * temp ) * exp;
	const newPos = target + ( change + temp ) * exp;
	return { newPos, newVel };
}

function tickScroll( ts ) {
	if ( scrollTargetY === null ) {
		scrollAnimating = false;
		scrollVel = 0;
		return;
	}
	const dt = lastFrameTs ? Math.min( MAX_DT, ( ts - lastFrameTs ) / 1000 ) : 1 / 60;
	lastFrameTs = ts;

	const smoothTime = BASE_SMOOTH_TIME / speedMultiplier;
	const result = smoothDamp( scrollPos, scrollTargetY, scrollVel, smoothTime, dt );
	scrollPos = result.newPos;
	scrollVel = result.newVel;

	if (
		Math.abs( scrollPos - scrollTargetY ) < POSITION_THRESHOLD
		&& Math.abs( scrollVel ) < VELOCITY_THRESHOLD
	) {
		scrollPos = scrollTargetY;
		window.scrollTo( 0, scrollPos );
		scrollTargetY = null;
		scrollVel = 0;
		scrollAnimating = false;
		return;
	}
	window.scrollTo( 0, scrollPos );
	requestAnimationFrame( tickScroll );
}

export function cancelScroll() {
	scrollTargetY = null;
	scrollVel = 0;
	scrollAnimating = false;
}

export function scrollToWord( index, ranges, opts = {} ) {
	if ( !ranges || index < 0 || index >= ranges.length ) return;
	const range = ranges[index];
	const rect = range.getBoundingClientRect();
	if ( rect.width === 0 && rect.height === 0 ) return;
	const verticalAnchor = opts.verticalAnchor ?? READING_ANCHOR_RATIO;
	const targetY = Math.max( 0, window.scrollY + rect.top - window.innerHeight * verticalAnchor );
	if ( opts.smooth === false ) {
		scrollTargetY = null;
		scrollVel = 0;
		scrollAnimating = false;
		scrollPos = targetY;
		window.scrollTo( 0, targetY );
		return;
	}
	if ( !scrollAnimating ) {
		// Sync from the live scroll position — the user may have moved during the gap.
		scrollPos = window.scrollY;
		scrollVel = 0;
	}
	scrollTargetY = targetY;
	if ( !scrollAnimating ) {
		scrollAnimating = true;
		lastFrameTs = 0;
		requestAnimationFrame( tickScroll );
	}
}

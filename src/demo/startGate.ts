/**
 * Debugging aid for Phase-1b crash bisection.
 *
 * Defers every heavy operation until the user clicks a "Start" button. This
 * gives the browser devtools time to attach before TSL shaders compile, and
 * makes it possible to refresh the page without retriggering a GPU hang.
 *
 * Also wraps an async runner in try/catch and logs each stage so when a
 * shader compile locks the GPU we at least know which LUT / bake was in
 * flight.
 */

export function createStartGate( { label = 'Start', stages = [] } = {} ) {

	const overlay = document.createElement( 'div' );
	overlay.style.cssText = [
		'position:fixed',
		'inset:0',
		'display:flex',
		'flex-direction:column',
		'gap:12px',
		'align-items:center',
		'justify-content:center',
		'background:rgba(0,0,0,0.85)',
		'color:#eee',
		'z-index:1000',
		'font-family:system-ui,sans-serif'
	].join( ';' );

	const btn = document.createElement( 'button' );
	btn.textContent = label;
	btn.style.cssText = 'padding:14px 28px;font-size:16px;border-radius:6px;border:0;cursor:pointer;background:#39c;color:#fff';

	const hint = document.createElement( 'div' );
	hint.style.cssText = 'max-width:560px;font-size:13px;line-height:1.5;text-align:center;color:#bbb';
	hint.innerHTML = 'Open the browser devtools console, then click <b>Start</b>.<br>' +
		'If a stage hangs, the last logged stage is where it died.';

	const stageList = document.createElement( 'div' );
	stageList.style.cssText = 'font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#888;min-width:280px';
	if ( stages.length ) {

		stageList.innerHTML = stages.map( ( s ) => `◯ ${s}` ).join( '<br>' );

	}

	overlay.appendChild( btn );
	overlay.appendChild( hint );
	if ( stages.length ) overlay.appendChild( stageList );
	document.body.appendChild( overlay );

	const markStage = ( idx, status = 'done' ) => {

		if ( ! stages.length ) return;
		const glyph = status === 'running' ? '◌' : status === 'error' ? '✕' : '●';
		stageList.innerHTML = stages
			.map( ( s, i ) => {

				const g = i < idx ? '●' : i === idx ? glyph : '◯';
				return `${g} ${s}`;

			} )
			.join( '<br>' );

	};

	return {

		run( fn ) {

			return new Promise( ( resolve ) => {

				btn.addEventListener( 'click', async () => {

					btn.disabled = true;
					btn.textContent = 'Running…';
					try {

						await fn( { markStage } );
						overlay.remove();
						resolve();

					} catch ( err ) {

						console.error( '[startGate] stage failed:', err );
						btn.textContent = 'Failed — see console';
						btn.style.background = '#c33';
						resolve();

					}

				}, { once: true } );

			} );

		}

	};

}

/**
 * Small wrapper that logs + times a single async stage.
 */
export async function logStage( name, fn ) {

	console.log( `[stage] → ${name}` );
	const t0 = performance.now();
	try {

		const out = await fn();
		console.log( `[stage] ← ${name} (${( performance.now() - t0 ).toFixed( 1 )}ms)` );
		return out;

	} catch ( err ) {

		console.error( `[stage] ✕ ${name}`, err );
		throw err;

	}

}

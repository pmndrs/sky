import { createContext, useContext } from 'react';

export const SkyContext = createContext( null );

/**
 * Returns the active `Sky` instance, or `null` if no `<Sky>` is mounted.
 *
 * Use this to reach the underlying instance from a child component — for
 * example to call `applyHaze` from a `useRenderPipeline` callback:
 *
 *   const sky = useSky();
 *   useRenderPipeline(({ renderPipeline, passes }) => {
 *     if (!sky) return;
 *     renderPipeline.outputNode = sky.applyHaze(
 *       passes.scenePass.getTextureNode(),
 *       { scenePass: passes.scenePass }
 *     );
 *   });
 */
export function useSky() {

	return useContext( SkyContext );

}

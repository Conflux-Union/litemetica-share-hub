/**
 * Tiled-atlas sampling patch for the viewer's textured materials
 * (three ^0.170, MeshLambertMaterial).
 *
 * The mesher (render/surface) emits uvs in the model's local 0..16 texel
 * space — merged greedy quads span 0..16*w — plus a per-vertex tile origin
 * attribute. The atlas is a gutterless 2D grid of 16px tiles, so the
 * fragment shader wraps the local uv back into a single tile
 * (fract(localUv/16 * (1 - 1e-4)), the shrink keeping samples off the tile
 * edge) and offsets by the origin — the same mapping computeAtlasUv
 * (render/assets) spells out for tests.
 *
 * The patch stays minimal: three ShaderChunk insertions on the stock
 * lambert shaders, a `tileSpan` uniform for the whole atlas, and a
 * customProgramCacheKey so patched programs cache separately.
 */

import * as THREE from 'three'

/** Patch one textured material in place; `span` comes from
 * atlasTileSpan(bundle). */
export function applyTiledAtlas(material: THREE.MeshLambertMaterial, span: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.tileSpan = { value: span }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <uv_pars_vertex>',
        `#include <uv_pars_vertex>
attribute vec2 tileOrigin;
varying vec2 vTileOrigin;
varying vec2 vTileLocalUv;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
vTileOrigin = tileOrigin;
vTileLocalUv = uv;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <uv_pars_fragment>',
        `#include <uv_pars_fragment>
varying vec2 vTileOrigin;
varying vec2 vTileLocalUv;
uniform float tileSpan;`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec2 tiledUv = vec2(
    vTileOrigin.x + fract( vTileLocalUv.x / 16.0 * ( 1.0 - 1e-4 ) ) * tileSpan,
    vTileOrigin.y - fract( vTileLocalUv.y / 16.0 * ( 1.0 - 1e-4 ) ) * tileSpan
  );
  vec4 sampledDiffuseColor = texture2D( map, tiledUv );
  diffuseColor *= sampledDiffuseColor;
#endif`,
      )
  }
  material.customProgramCacheKey = () => 'lsh-tiled-atlas'
}

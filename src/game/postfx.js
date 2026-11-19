import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'

// What each quality level costs: 'low' renders straight to the screen.
// 'medium' adds depth of field and colour grading in one extra pass, with
// edge smoothing done in that same pass. 'high' adds glow, ambient occlusion,
// true multisampling and full display resolution; that wants a dedicated GPU.
// Measured on a Radeon 880M at 2560 x 1388: multisampling and glow cost
// 7 to 10 ms each, the combined last pass about 2 ms.
export const QUALITY = {
  low: { pixelRatio: 1, shadow: 2048, post: false, people: 8, cars: 5 },
  medium: { pixelRatio: 1, shadow: 4096, post: true, msaa: 0, taps: 6, blur: 3, glow: false, ao: false, people: 12, cars: 7 },
  high: { pixelRatio: 2, shadow: 4096, post: true, msaa: 4, taps: 16, blur: 4.5, glow: true, ao: true, people: 16, cars: 9 },
}

// The last pass does everything that only needs one look at the picture:
// depth of field (sharp around the focus distance, soft far away and right in
// front of the lens), a little extra colour, darker corners, then tone mapping
// and conversion for the screen.
const Finish = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    near: { value: 0.5 },
    far: { value: 30000 },
    focus: { value: 8 },
    radius: { value: 5 }, // largest blur in pixels
    texel: { value: new THREE.Vector2() },
    exposure: { value: 0.5 },
    time: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform float near; uniform float far; uniform float focus; uniform float radius; uniform float exposure; uniform float time; uniform vec2 texel;
    varying vec2 vUv;

    float viewZ( vec2 uv ) {
      return - perspectiveDepthToViewZ( texture2D( tDepth, uv ).x, near, far );
    }

    float blurAt( vec2 uv ) {
      float z = viewZ( uv );
      float behind = smoothstep( focus * 3.0, focus * 28.0, z );
      float front = 1.0 - smoothstep( focus * 0.12, focus * 0.4, z );
      return max( behind, front * 0.7 );
    }

    // FXAA: where neighbouring pixels differ a lot, blend along the edge
    float luma( vec3 c ) { c = c / ( 1.0 + c ); return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }
    vec3 smoothEdge( vec2 uv ) {
      vec3 m = texture2D( tDiffuse, uv ).rgb;
      float nw = luma( texture2D( tDiffuse, uv + vec2( -1.0, -1.0 ) * texel ).rgb );
      float ne = luma( texture2D( tDiffuse, uv + vec2( 1.0, -1.0 ) * texel ).rgb );
      float sw = luma( texture2D( tDiffuse, uv + vec2( -1.0, 1.0 ) * texel ).rgb );
      float se = luma( texture2D( tDiffuse, uv + vec2( 1.0, 1.0 ) * texel ).rgb );
      float lm = luma( m );
      float lo = min( lm, min( min( nw, ne ), min( sw, se ) ) );
      float hi = max( lm, max( max( nw, ne ), max( sw, se ) ) );
      if ( hi - lo < max( 0.025, hi * 0.125 ) ) return m;
      vec2 dir = vec2( - ( ( nw + ne ) - ( sw + se ) ), ( nw + sw ) - ( ne + se ) );
      float reduce = max( ( nw + ne + sw + se ) * 0.03125, 0.0078125 );
      dir = clamp( dir / ( min( abs( dir.x ), abs( dir.y ) ) + reduce ), -8.0, 8.0 ) * texel;
      vec3 a = 0.5 * ( texture2D( tDiffuse, uv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb + texture2D( tDiffuse, uv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
      vec3 b = a * 0.5 + 0.25 * ( texture2D( tDiffuse, uv - dir * 0.5 ).rgb + texture2D( tDiffuse, uv + dir * 0.5 ).rgb );
      float lb = luma( b );
      return ( lb < lo || lb > hi ) ? a : b;
    }

    // ACES filmic curve, the same one the renderer uses
    vec3 fit( vec3 v ) {
      vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
      vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
      return a / b;
    }
    vec3 filmic( vec3 c ) {
      const mat3 inM = mat3( 0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777 );
      const mat3 outM = mat3( 1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602 );
      return clamp( outM * fit( inM * ( c * exposure / 0.6 ) ), 0.0, 1.0 );
    }

    void main() {
      float c = blurAt( vUv );
      #ifdef FXAA
        vec3 sum = smoothEdge( vUv );
      #else
        vec3 sum = texture2D( tDiffuse, vUv ).rgb;
      #endif
      // less than half a pixel of blur is not worth the extra lookups
      if ( c * radius > 0.5 ) {
        float total = 1.0;
        for ( int i = 0; i < TAPS; i ++ ) {
          float a = float( i ) * 2.39996;
          float r = sqrt( ( float( i ) + 0.5 ) / float( TAPS ) ) * c * radius;
          vec2 uv = vUv + vec2( cos( a ), sin( a ) ) * r * texel;
          // sharp things must not smear into the blur around them
          float w = mix( 0.08, 1.0, clamp( blurAt( uv ) / c, 0.0, 1.0 ) );
          sum += texture2D( tDiffuse, uv ).rgb * w;
          total += w;
        }
        sum /= total;
      }
      float l = dot( sum, vec3( 0.2126, 0.7152, 0.0722 ) );
      sum = mix( vec3( l ), sum, 1.14 );
      // split toning: shadows lean blue, lit surfaces lean orange
      float lit = smoothstep( 0.12, 1.5, dot( sum, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      sum *= mix( vec3( 0.88, 0.97, 1.16 ), vec3( 1.08, 1.0, 0.9 ), lit );
      float v = length( vUv - 0.5 );
      sum *= 1.0 - 0.9 * v * v * v;
      sum = filmic( max( sum, 0.0 ) );
      sum = mix( pow( sum, vec3( 0.41666 ) ) * 1.055 - 0.055, sum * 12.92, vec3( lessThanEqual( sum, vec3( 0.0031308 ) ) ) );
      // film grain
      float grain = fract( sin( dot( vUv * ( 1.0 + fract( time ) ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
      sum += ( grain - 0.5 ) * 0.035;
      gl_FragColor = vec4( sum, 1.0 );
    }`,
}

export function createComposer(renderer, scene, camera, quality) {
  const q = QUALITY[quality]
  if (!q.post) return null
  const size = renderer.getDrawingBufferSize(new THREE.Vector2())
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q.msaa })
  target.depthTexture = new THREE.DepthTexture(size.x, size.y)
  const composer = new EffectComposer(renderer, target)
  composer.addPass(new RenderPass(scene, camera))
  // glow at half resolution; only the really bright bits: sun on chrome, lamps, brake lights.
  // It is added onto the scene buffer, so the depth in there stays intact for the last pass.
  if (q.glow) composer.addPass(new UnrealBloomPass(size.clone().multiplyScalar(0.5), 0.22, 0.5, 6))
  if (q.ao) {
    const ao = new GTAOPass(scene, camera, size.x, size.y)
    ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 1.5, scale: 1.25, samples: 12 })
    ao.blendIntensity = 0.9
    composer.addPass(ao)
  }
  const defines = { TAPS: q.taps }
  if (!q.msaa) defines.FXAA = 1
  const finish = new ShaderPass({ ...Finish, defines })
  finish.uniforms.radius.value = q.blur * renderer.getPixelRatio()
  composer.addPass(finish)
  composer.finish = finish
  composer.blur = q.blur
  // the buffer the scene is drawn into; its depth feeds the depth of field
  composer.sceneDepth = () => composer.readBuffer.depthTexture
  return composer
}

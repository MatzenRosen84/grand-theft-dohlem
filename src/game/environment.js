import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import { clamp, lerp, smoothstep } from './util.js'
import { cloudCanvas } from './textures.js'

const DEG = Math.PI / 180

// Sky, sun, ambient light and haze, driven by the time of day (hours, 6 to 23.5).
// After 21:30 the sun is below the horizon and it gets dark.
export class Environment {
  constructor(scene, renderer, shadowSize = 4096) {
    this.scene = scene
    this.renderer = renderer

    this.sky = new Sky()
    this.sky.scale.setScalar(20000)
    const u = this.sky.material.uniforms
    u.turbidity.value = 5
    u.rayleigh.value = 1.4
    u.mieCoefficient.value = 0.004
    u.mieDirectionalG.value = 0.82
    scene.add(this.sky)

    this.sun = new THREE.DirectionalLight(0xffffff, 3)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowSize, shadowSize)
    this.sun.shadow.bias = -0.0003
    scene.add(this.sun, this.sun.target)

    this.ambient = new THREE.HemisphereLight(0xbfd6ff, 0x5c5a3c, 1)
    scene.add(this.ambient)

    scene.fog = new THREE.FogExp2(0xbcd0e0, 0.00042)
    // the sky also lights the scene and shows up in paint and glass
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.skyScene = new THREE.Scene()
    const copy = new Sky()
    copy.material = this.sky.material
    copy.scale.setScalar(20000)
    this.skyScene.add(copy)
    // the land below the horizon, so paintwork reflects ground and not black
    const land = new THREE.Mesh(new THREE.CircleGeometry(18000, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a4428 }))
    land.position.y = -30
    this.skyScene.add(land)
    scene.environmentIntensity = 0.3
    this.addClouds()

    this.dir = new THREE.Vector3()
    this.shadowExtent = 0
    this.setTime(17.5)
  }

  setTime(hours) {
    this.hours = hours
    const day = clamp((hours - 5.5) / 16, 0, 1) // sunrise 5:30, sunset 21:30
    let elevation = Math.sin(day * Math.PI) * 58 * DEG
    if (hours > 21.5) elevation = -(hours - 21.5) * 7 * DEG
    this.dark = smoothstep(4 * DEG, -8 * DEG, elevation) // 0 by day, 1 at night
    const night = this.dark
    const azimuth = lerp(75, 290, day) * DEG // east, over south, to north-west
    this.dir.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation))
    this.sky.material.uniforms.sunPosition.value.copy(this.dir)

    const high = smoothstep(2 * DEG, 30 * DEG, elevation) // 0 at the horizon, 1 well up
    const up = smoothstep(-1 * DEG, 8 * DEG, elevation)
    this.sun.color.setRGB(1, lerp(0.6, 0.95, high), lerp(0.28, 0.86, high))
    this.sun.intensity = lerp(5.4, 3.4, high) * up
    // low sun: more dust in the air, so the sky turns orange towards the horizon
    const su = this.sky.material.uniforms
    su.turbidity.value = lerp(7, 5, high)
    su.rayleigh.value = lerp(3.2, 1.4, high)
    this.ambient.intensity = lerp(1.25, 1.1, high) * lerp(1, 0.32, night)
    this.ambient.color.setRGB(lerp(1, 0.72, high) * lerp(1, 0.5, night), lerp(0.76, 0.83, high) * lerp(1, 0.75, night), lerp(0.62, 1, high) * lerp(1, 1.5, night))
    const f = lerp(1, 0.06, night)
    this.scene.fog.color.setRGB(lerp(0.95, 0.7, high) * f, lerp(0.66, 0.79, high) * f * 1.1, lerp(0.42, 0.88, high) * f * 1.5)
    // evening mist: thicker when the sun is low
    this.scene.fog.density = lerp(0.0014, 0.00042, high)
    this.scene.environmentIntensity = lerp(0.3, 0.6, night)
    this.renderer.toneMappingExposure = lerp(0.62, 0.5, high)
    const cu = this.cloudMat.uniforms
    const dim = lerp(1, 0.02, night)
    cu.lit.value.setRGB(lerp(9, 11, high), lerp(6.2, 10.6, high), lerp(4.4, 10.2, high)).multiplyScalar(dim)
    cu.shade.value.setRGB(lerp(2.6, 5.2, high), lerp(2.4, 5.8, high), lerp(2.8, 6.8, high)).multiplyScalar(dim)

    // re-baking the reflection map is too slow to do on every slider step
    clearTimeout(this.envTimer)
    if (this.envMap) this.envTimer = setTimeout(() => this.bakeSky(), 150)
    else this.bakeSky()
  }

  // a layer of drifting fair-weather clouds
  addClouds() {
    const map = new THREE.CanvasTexture(cloudCanvas(512, 9))
    map.wrapS = map.wrapT = THREE.RepeatWrapping
    this.cloudMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: { map: { value: map }, time: { value: 0 }, lit: { value: new THREE.Color() }, shade: { value: new THREE.Color() } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: `
        uniform sampler2D map; uniform float time; uniform vec3 lit; uniform vec3 shade; varying vec2 vUv;
        void main() {
          vec2 p = vUv * 5.0 + vec2( time * 0.004, time * 0.0015 );
          float a = texture2D( map, p ).r;
          float b = texture2D( map, p * 2.7 + 0.3 ).r;
          float d = smoothstep( 0.5, 0.68, a * 0.72 + b * 0.28 );
          float edge = 1.0 - smoothstep( 0.2, 0.5, length( vUv - 0.5 ) );
          gl_FragColor = vec4( mix( shade, lit, smoothstep( 0.45, 0.8, b ) ), d * edge * 0.9 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    const clouds = new THREE.Mesh(new THREE.PlaneGeometry(70000, 70000).rotateX(Math.PI / 2), this.cloudMat)
    clouds.position.y = 2600
    clouds.renderOrder = -1
    clouds.frustumCulled = false
    this.scene.add(clouds)
  }

  bakeSky() {
    const old = this.envMap
    this.envMap = this.pmrem.fromScene(this.skyScene, 0, 1, 30000)
    this.scene.environment = this.envMap.texture
    old?.dispose()
  }

  // keep the shadow map centred on what the camera looks at
  follow(target, viewDistance) {
    this.cloudMat.uniforms.time.value = performance.now() / 1000
    const extent = clamp(viewDistance * 0.8, 90, 1100)
    const cam = this.sun.shadow.camera
    if (Math.abs(extent - this.shadowExtent) > this.shadowExtent * 0.08) {
      this.shadowExtent = extent
      cam.left = cam.bottom = -extent
      cam.right = cam.top = extent
      cam.near = 10
      cam.far = 5000
      cam.updateProjectionMatrix()
      this.sun.shadow.normalBias = extent * 0.004
    }
    // move in whole texels, otherwise shadow edges crawl while the camera moves
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x
    const x = Math.round(target.x / texel) * texel
    const z = Math.round(target.z / texel) * texel
    this.sun.target.position.set(x, target.y, z)
    this.sun.position.set(x, target.y, z).addScaledVector(this.dir, 2500)
  }
}

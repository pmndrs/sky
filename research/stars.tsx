"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber/webgpu";
import { useSky } from "@pmndrs/sky/react";
import * as TSL from "three/tsl";
import * as THREE from "three/webgpu";

/** Sky elevation used for twilight. */
interface SkyWithSun {
  sunElevation: number;
}

export interface StarsOptions {
  /** How many stars to scatter over the dome. */
  count?: number;
  /** Overall luminance of the field. */
  intensity?: number;
  /** Star diameter in render target pixels. */
  size?: number;
  /** Peak twinkle depth from 0 to 1. */
  twinkle?: number;
  /** Solar time in hours, shared with the atmosphere. */
  timeOfDay?: number;
  /** Observer latitude. Paris by default. */
  latitude?: number;
  /** Calendar day, shared with the atmosphere's solar model. */
  dayOfYear?: number;
  /** Which world axis points north. */
  north?: string;
}

/** Sun elevation range for the Paris twilight ramp. */
const TWILIGHT_START = 1;
const TWILIGHT_END = -15;

/** Star dome radius inside the camera far plane. */
const DOME_RADIUS = 4000;

/** Number of sprites in the Milky Way veil. */
const MILKY_WAY_CLOUDS = 176;

interface BrightStar {
  /** Right ascension, decimal hours. */
  ra: number;
  /** Declination, degrees. */
  dec: number;
  /** Apparent visual magnitude. Lower is brighter. */
  magnitude: number;
  /** Color range from amber at 0 to blue white at 1. */
  tone: number;
}

/** Bright stars that anchor the northern summer sky. */
const BRIGHT_STARS: BrightStar[] = [
  // Summer Triangle.
  { ra: 18.6156, dec: 38.7837, magnitude: 0.03, tone: 0.82 }, // Vega
  { ra: 19.8464, dec: 8.8683, magnitude: 0.77, tone: 0.88 }, // Altair
  { ra: 20.6905, dec: 45.2803, magnitude: 1.25, tone: 0.72 }, // Deneb
  // The June meridian and southern horizon.
  { ra: 14.261, dec: 19.1824, magnitude: -0.05, tone: 0.12 }, // Arcturus
  { ra: 13.4199, dec: -11.1613, magnitude: 0.98, tone: 0.9 }, // Spica
  { ra: 16.4901, dec: -26.432, magnitude: 1.06, tone: 0.02 }, // Antares
  { ra: 10.1395, dec: 11.9672, magnitude: 1.35, tone: 0.86 }, // Regulus
  { ra: 7.655, dec: 5.225, magnitude: 0.34, tone: 0.5 }, // Procyon
  { ra: 7.7553, dec: 28.0262, magnitude: 1.14, tone: 0.24 }, // Pollux
  { ra: 7.5767, dec: 31.8883, magnitude: 1.58, tone: 0.72 }, // Castor
  { ra: 22.9608, dec: -29.6222, magnitude: 1.16, tone: 0.78 }, // Fomalhaut
  // Big Dipper, including the dimmer bowl stars so its shape arrives later.
  { ra: 11.0621, dec: 61.7508, magnitude: 1.79, tone: 0.28 }, // Dubhe
  { ra: 11.0307, dec: 56.3824, magnitude: 2.37, tone: 0.75 }, // Merak
  { ra: 11.8972, dec: 53.6948, magnitude: 2.41, tone: 0.7 }, // Phecda
  { ra: 12.2571, dec: 57.0326, magnitude: 3.31, tone: 0.72 }, // Megrez
  { ra: 12.9005, dec: 55.9598, magnitude: 1.77, tone: 0.88 }, // Alioth
  { ra: 13.3987, dec: 54.9254, magnitude: 2.23, tone: 0.74 }, // Mizar
  { ra: 13.7923, dec: 49.3133, magnitude: 1.86, tone: 0.88 }, // Alkaid
  // Cassiopeia and the north marker.
  { ra: 0.1529, dec: 59.1498, magnitude: 2.27, tone: 0.66 }, // Caph
  { ra: 0.6751, dec: 56.5373, magnitude: 2.24, tone: 0.18 }, // Schedar
  { ra: 0.9451, dec: 60.7167, magnitude: 2.47, tone: 0.8 }, // Gamma Cas
  { ra: 1.4303, dec: 60.2353, magnitude: 2.68, tone: 0.78 }, // Ruchbah
  { ra: 1.9066, dec: 63.67, magnitude: 3.35, tone: 0.85 }, // Segin
  { ra: 2.5303, dec: 89.2641, magnitude: 1.98, tone: 0.48 }, // Polaris
];

const DEG = Math.PI / 180;
const EQUATORIAL_NORTH = new THREE.Vector3(0, 1, 0);

/** Unit direction in equatorial coordinates. */
function equatorialDirection(raHours: number, decDegrees: number) {
  const ra = raHours * 15 * DEG;
  const dec = decDegrees * DEG;
  const cosDec = Math.cos(dec);
  return new THREE.Vector3(
    cosDec * Math.cos(ra),
    Math.sin(dec),
    cosDec * Math.sin(ra),
  );
}

/** IAU galactic north pole, which fixes the real Milky Way great circle. */
const GALACTIC_NORTH = equatorialDirection(12.8595, 27.1284);
const GALACTIC_BASIS_A = new THREE.Vector3()
  .crossVectors(GALACTIC_NORTH, EQUATORIAL_NORTH)
  .normalize();
const GALACTIC_BASIS_B = new THREE.Vector3()
  .crossVectors(GALACTIC_NORTH, GALACTIC_BASIS_A)
  .normalize();

function directionOnGalacticPlane(angle: number, offset = 0) {
  return new THREE.Vector3()
    .addScaledVector(GALACTIC_BASIS_A, Math.cos(angle) * Math.cos(offset))
    .addScaledVector(GALACTIC_BASIS_B, Math.sin(angle) * Math.cos(offset))
    .addScaledVector(GALACTIC_NORTH, Math.sin(offset))
    .normalize();
}

/**
 * Rotates equatorial coordinates into the local horizon.
 * Sidereal time is derived from the same solar time used by the atmosphere.
 */
function celestialOrientation(
  latitude: number,
  dayOfYear: number,
  timeOfDay: number,
  north: string,
) {
  const obliquity = 23.4393 * DEG;
  const solarLongitude = ((dayOfYear - 80.25) / 365.2422) * Math.PI * 2;
  const solarRa = Math.atan2(
    Math.cos(obliquity) * Math.sin(solarLongitude),
    Math.cos(solarLongitude),
  );
  const sidereal =
    solarRa + (timeOfDay - 12) * 15 * 1.0027379 * DEG;
  const sinSidereal = Math.sin(sidereal);
  const cosSidereal = Math.cos(sidereal);
  const lat = latitude * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);

  // Rows map equatorial x/y/z to east/up/north in world x/y/z.
  const horizon = new THREE.Matrix4().set(
    -sinSidereal,
    0,
    cosSidereal,
    0,
    cosLat * cosSidereal,
    sinLat,
    cosLat * sinSidereal,
    0,
    -sinLat * cosSidereal,
    cosLat,
    -sinLat * sinSidereal,
    0,
    0,
    0,
    0,
    1,
  );

  const northRotation =
    north === "-Z"
      ? Math.PI
      : north === "+X"
        ? Math.PI / 2
        : north === "-X"
          ? -Math.PI / 2
          : 0;

  return new THREE.Matrix4()
    .makeRotationY(northRotation)
    .multiply(horizon);
}

/** Restores vector types lost by `instancedBufferAttribute`. */
const instancedVec3 = (attr: THREE.InstancedBufferAttribute) =>
  TSL.instancedBufferAttribute(attr) as unknown as ReturnType<typeof TSL.vec3>;
const instancedVec4 = (attr: THREE.InstancedBufferAttribute) =>
  TSL.instancedBufferAttribute(attr) as unknown as ReturnType<typeof TSL.vec4>;

/** Deterministic PRNG that keeps the star field stable. */
function makeRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Renders stars as instanced raster sized sprites with a second Milky Way layer.
 * Magnitude and sun elevation control their order of appearance in twilight.
 */
export function Stars({
  count = 4200,
  intensity = 2.8,
  size = 5.25,
  twinkle = 0.28,
  timeOfDay = 20.5,
  latitude = 48.8566,
  dayOfYear = 176,
  north = "+Z",
}: StarsOptions) {
  const sky = useSky() as unknown as SkyWithSun | null;
  const orientation = useMemo(
    () => celestialOrientation(latitude, dayOfYear, timeOfDay, north),
    [latitude, dayOfYear, timeOfDay, north],
  );

  /** Live uniforms for twilight, size, intensity, and twinkle. */
  const uniforms = useMemo(
    () => ({
      time: TSL.uniform(0),
      darkness: TSL.uniform(0),
      intensity: TSL.uniform(intensity),
      twinkle: TSL.uniform(twinkle),
      size: TSL.uniform(size),
    }),
    // Effects update these uniforms after creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    uniforms.intensity.value = intensity;
    uniforms.twinkle.value = twinkle;
    uniforms.size.value = size;
  }, [uniforms, intensity, twinkle, size]);

  const { geometry, material, veilGeometry, veilMaterial } = useMemo(() => {
    const random = makeRandom(0x5eed);

    const totalCount = count + BRIGHT_STARS.length;
    const offsets = new Float32Array(totalCount * 3);
    // Store magnitude, phase, hue, and twinkle speed per star.
    const traits = new Float32Array(totalCount * 4);

    for (let i = 0; i < count; i++) {
      // Draw part of the field near the galactic plane for extra density.
      const inMilkyWay = random() < 0.34;
      let direction: THREE.Vector3;
      if (inMilkyWay) {
        const angle = random() * Math.PI * 2;
        // Four samples create a soft distribution around the plane.
        const offset =
          (random() + random() + random() + random() - 2) * 0.12;
        direction = directionOnGalacticPlane(angle, offset);
      } else {
        // Sample y uniformly for an even solid angle distribution.
        const y = random() * 2 - 1;
        const radius = Math.sqrt(Math.max(0, 1 - y * y));
        const ra = random() * Math.PI * 2;
        direction = new THREE.Vector3(
          Math.cos(ra) * radius,
          y,
          Math.sin(ra) * radius,
        );
      }

      offsets[i * 3] = direction.x * DOME_RADIUS;
      offsets[i * 3 + 1] = direction.y * DOME_RADIUS;
      offsets[i * 3 + 2] = direction.z * DOME_RADIUS;

      // Skew magnitude toward faint stars and reserve the brightest values.
      traits[i * 4] =
        Math.pow(random(), inMilkyWay ? 3 : 2.55) *
        (inMilkyWay ? 0.68 : 0.8);
      traits[i * 4 + 1] = random() * Math.PI * 2;
      // Give dense galactic stars a warmer color range.
      traits[i * 4 + 2] = inMilkyWay ? random() * 0.72 : random();
      // Vary twinkle speed so the field does not pulse together.
      traits[i * 4 + 3] = 0.35 + random() * 0.5;
    }

    for (let i = 0; i < BRIGHT_STARS.length; i++) {
      const index = count + i;
      const star = BRIGHT_STARS[i];
      const direction = equatorialDirection(star.ra, star.dec);

      offsets[index * 3] = direction.x * DOME_RADIUS;
      offsets[index * 3 + 1] = direction.y * DOME_RADIUS;
      offsets[index * 3 + 2] = direction.z * DOME_RADIUS;

      // Map visual magnitude to shader brightness while preserving spacing.
      traits[index * 4] = THREE.MathUtils.clamp(
        1 - (star.magnitude + 1.5) / 12,
        0.46,
        1,
      );
      traits[index * 4 + 1] = random() * Math.PI * 2;
      traits[index * 4 + 2] = star.tone;
      traits[index * 4 + 3] = 0.28 + random() * 0.38;
    }

    // Use one instanced quad as the billboard source for every star.
    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute("position", quad.attributes.position);
    geometry.setAttribute("uv", quad.attributes.uv);
    quad.dispose();

    const offsetAttr = new THREE.InstancedBufferAttribute(offsets, 3);
    const traitAttr = new THREE.InstancedBufferAttribute(traits, 4);
    geometry.setAttribute("aOffset", offsetAttr);
    geometry.setAttribute("aTrait", traitAttr);
    geometry.instanceCount = totalCount;

    const trait = instancedVec4(traitAttr);
    const magnitude = trait.x;
    const phase = trait.y;
    const hue = trait.z;
    const speed = trait.w;

    /** Reveal bright stars before faint stars as darkness increases. */
    const threshold = TSL.float(1).sub(magnitude).mul(0.32);
    const emergence = TSL.smoothstep(
      threshold,
      threshold.add(0.34),
      uniforms.darkness,
    );

    /** Fade stars near the horizon to keep the skyline clear. */
    const altitude = TSL.smoothstep(
      0.015,
      0.1,
      TSL.positionWorld.normalize().y,
    );

    /** Multiply two detuned waves so twinkle does not form a shared pulse. */
    const t = uniforms.time.mul(speed);
    const shimmer = TSL.sin(t.add(phase))
      .mul(TSL.sin(t.mul(0.61).add(phase.mul(1.7))))
      .mul(uniforms.twinkle);

    // Use subtle warm and cool tints across the field.
    const tint = TSL.mix(
      TSL.vec3(1.0, 0.94, 0.88),
      TSL.vec3(0.84, 0.9, 1.0),
      hue,
    );

    // Add a four ray glint only to the brightest stars.
    const centeredUv = TSL.uv().sub(0.5);
    const core = TSL.smoothstep(1, 0, centeredUv.length().mul(2)).pow(2.35);
    const verticalRay = TSL.smoothstep(0.07, 0, TSL.abs(centeredUv.x))
      .pow(2)
      .mul(TSL.smoothstep(0.5, 0, TSL.abs(centeredUv.y)).pow(2));
    const horizontalRay = TSL.smoothstep(0.055, 0, TSL.abs(centeredUv.y))
      .pow(2)
      .mul(TSL.smoothstep(0.5, 0, TSL.abs(centeredUv.x)).pow(2));
    const glint = verticalRay
      .add(horizontalRay)
      .mul(TSL.smoothstep(0.76, 0.94, magnitude))
      .mul(0.34);
    const shape = core.add(glint);

    const luminance = TSL.float(0.3)
      .add(magnitude.mul(0.7))
      .mul(TSL.float(1).add(shimmer))
      .mul(emergence)
      .mul(altitude)
      .mul(uniforms.intensity);

    const material = new THREE.SpriteNodeMaterial();
    material.positionNode = instancedVec3(offsetAttr);
    material.sizeAttenuation = false;

    /**
     * Compensate for projection and target height so sprite size stays fixed
     * in render target pixels.
     */
    // TSL types omit matrix column access.
    const projColumns = TSL.cameraProjectionMatrix as unknown as ReturnType<
      typeof TSL.vec4
    >[];
    material.scaleNode = uniforms.size
      .mul(TSL.float(0.55).add(magnitude.mul(0.8)))
      .mul(2)
      .div(projColumns[1].y.mul(TSL.screenSize.y));

    material.colorNode = TSL.vec4(tint.mul(shape).mul(TSL.max(luminance, 0)), 1);
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    /** Test scene depth without replacing the sky depth value. */
    material.depthTest = true;
    material.depthWrite = false;
    // Disable scene fog because stars are rendered at infinity.
    material.fog = false;

    /** Feathered sprites along the galactic plane form a soft Milky Way veil. */
    const veilOffsets = new Float32Array(MILKY_WAY_CLOUDS * 3);
    // Store length, opacity, rotation, and warmth per cloud.
    const veilTraits = new Float32Array(MILKY_WAY_CLOUDS * 4);
    for (let i = 0; i < MILKY_WAY_CLOUDS; i++) {
      const angle =
        (i / MILKY_WAY_CLOUDS) * Math.PI * 2 + (random() - 0.5) * 0.16;
      const offset = (random() + random() - 1) * 0.085;
      const direction = directionOnGalacticPlane(angle, offset);

      veilOffsets[i * 3] = direction.x * (DOME_RADIUS * 0.997);
      veilOffsets[i * 3 + 1] = direction.y * (DOME_RADIUS * 0.997);
      veilOffsets[i * 3 + 2] = direction.z * (DOME_RADIUS * 0.997);
      veilTraits[i * 4] = 110 + random() * 130;
      veilTraits[i * 4 + 1] = 0.025 + random() * 0.04;
      veilTraits[i * 4 + 2] = random() * Math.PI;
      veilTraits[i * 4 + 3] = random();
    }

    const veilQuad = new THREE.PlaneGeometry(1, 1);
    const veilGeometry = new THREE.InstancedBufferGeometry();
    veilGeometry.index = veilQuad.index;
    veilGeometry.setAttribute("position", veilQuad.attributes.position);
    veilGeometry.setAttribute("uv", veilQuad.attributes.uv);
    veilQuad.dispose();

    const veilOffsetAttr = new THREE.InstancedBufferAttribute(veilOffsets, 3);
    const veilTraitAttr = new THREE.InstancedBufferAttribute(veilTraits, 4);
    veilGeometry.setAttribute("aOffset", veilOffsetAttr);
    veilGeometry.setAttribute("aTrait", veilTraitAttr);
    veilGeometry.instanceCount = MILKY_WAY_CLOUDS;

    const veilTrait = instancedVec4(veilTraitAttr);
    const veilUv = TSL.uv().sub(0.5);
    const veilFeather = TSL.smoothstep(1, 0, veilUv.length().mul(2)).pow(2.2);
    const veilMottle = TSL.sin(
      veilUv.x.mul(29).add(veilTrait.z.mul(3.1)),
    )
      .mul(TSL.sin(veilUv.y.mul(23).sub(veilTrait.z.mul(1.7))))
      .mul(0.14)
      .add(0.86);
    const laneCenter = TSL.sin(
      veilUv.x.mul(8).add(veilTrait.z.mul(2)),
    ).mul(0.04);
    const dustLane = TSL.smoothstep(
      0.018,
      0.1,
      TSL.abs(veilUv.y.sub(laneCenter)),
    )
      .mul(0.42)
      .add(0.58);
    const veilAltitude = TSL.smoothstep(
      0.025,
      0.14,
      TSL.positionWorld.normalize().y,
    );
    const veilEmergence = TSL.smoothstep(0.12, 0.82, uniforms.darkness);
    const veilStrength = veilTrait.y
      .mul(veilFeather)
      .mul(veilMottle)
      .mul(dustLane)
      .mul(veilAltitude)
      .mul(veilEmergence)
      .mul(uniforms.intensity)
      .mul(0.32);
    const veilTint = TSL.mix(
      TSL.vec3(0.23, 0.31, 0.56),
      TSL.vec3(0.42, 0.34, 0.38),
      veilTrait.w,
    );

    const veilMaterial = new THREE.SpriteNodeMaterial();
    veilMaterial.positionNode = instancedVec3(veilOffsetAttr);
    veilMaterial.rotationNode = veilTrait.z;
    veilMaterial.sizeAttenuation = false;
    const pixelScale = TSL.float(2).div(
      projColumns[1].y.mul(TSL.screenSize.y),
    );
    veilMaterial.scaleNode = TSL.vec2(
      veilTrait.x,
      veilTrait.x.mul(TSL.float(0.55).add(veilTrait.w.mul(0.25))),
    ).mul(pixelScale);
    veilMaterial.colorNode = TSL.vec4(
      veilTint.mul(TSL.max(veilStrength, 0)),
      1,
    );
    veilMaterial.transparent = true;
    veilMaterial.blending = THREE.AdditiveBlending;
    veilMaterial.depthTest = true;
    veilMaterial.depthWrite = false;
    veilMaterial.fog = false;

    return { geometry, material, veilGeometry, veilMaterial };
  }, [count, uniforms]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      veilGeometry.dispose();
      veilMaterial.dispose();
    },
    [geometry, material, veilGeometry, veilMaterial],
  );

  useFrame((state) => {
    uniforms.time.value = state.elapsed;

    // Derive the twilight ramp from the sky sun elevation.
    const elevation = sky?.sunElevation ?? -90;
    const ramp = (elevation - TWILIGHT_START) / (TWILIGHT_END - TWILIGHT_START);
    uniforms.darkness.value = Math.min(1, Math.max(0, ramp));
  });

  // Time controls the seasonal sky orientation.
  // Disable culling because both layers span the full dome.
  return (
    <group matrix={orientation} matrixAutoUpdate={false}>
      <mesh
        geometry={veilGeometry}
        material={veilMaterial}
        frustumCulled={false}
        renderOrder={-2}
      />
      <mesh
        geometry={geometry}
        material={material}
        frustumCulled={false}
        renderOrder={-1}
      />
    </group>
  );
}

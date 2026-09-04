// Declarations for asset imports handled by @rollup/plugin-url at build time.
// At runtime the import resolves to a base64 data URL string.
declare module "*.mp3" {
  const url: string;
  export default url;
}

// The Pixel City plates (pixelCityArt.ts) take the same route.
declare module "*.png" {
  const url: string;
  export default url;
}

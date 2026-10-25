// The gold frog shown while something loads (a search, a complaint being sent).
// A short H.264 video, not an animated picture: phones decode video in hardware,
// while 60 frames a second of animated WebP had to be unpacked by the processor
// and played slowed down. The video carries the frog on the app's dark colour
// with its glow; the edges fade out so no square shows around it.
export const FROG_VIDEO = "/brand/frog-loader.mp4";
const FROG_POSTER = "/brand/frog-loader-poster.webp";

// `size`: how wide the frog itself looks (the video is a bit larger around it).
export function FrogLoader({ size }: { size: number }) {
  const box = Math.round(size / 0.75);
  return (
    <video
      src={FROG_VIDEO}
      poster={FROG_POSTER}
      autoPlay
      loop
      muted
      playsInline
      disablePictureInPicture
      aria-hidden
      width={box}
      height={box}
      className="epb-frog-video pointer-events-none select-none"
      style={{ width: box, height: box, margin: -(box - size) / 2 }}
    />
  );
}

// Fetches the video ahead, so the first loader shows at once.
export function warmFrogLoader() {
  void fetch(FROG_VIDEO).catch(() => {});
}

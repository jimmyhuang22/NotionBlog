import { monogram } from "../lib/site/monogram.ts";

/** The configured picture, or the name's initials when none is set. */
export function Avatar({ src, name }: { src: string | null; name: string }) {
  return src
    ? <img className="avatar" src={src} alt={`${name} 的头像`} width={88} height={88} />
    : <div className="avatar" aria-hidden="true">{monogram(name)}</div>;
}

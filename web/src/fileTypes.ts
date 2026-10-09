const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
const AUDIO_TYPES: Record<string, string> = { m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", "3gp": "audio/3gpp" };

const extension = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

export const imageType = (name: string): string | undefined => IMAGE_TYPES[extension(name)];
export const audioType = (name: string): string | undefined => AUDIO_TYPES[extension(name)];
export const isPdf = (name: string): boolean => extension(name) === "pdf";
export const mimeType = (name: string): string => imageType(name) ?? audioType(name) ?? (isPdf(name) ? "application/pdf" : "application/octet-stream");

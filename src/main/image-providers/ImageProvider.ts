// A separate small interface from LLMProvider, deliberately — image generation is
// prompt-in/image-out, not a chat stream, and none of this app's 8 chat providers expose
// vision/image-generation through their chat API. One implementation for now
// (cloudflare-image.ts, reusing the Cloudflare Workers AI credentials already in Settings);
// more can be added the same way providers/ already does, if other free image APIs turn out
// to fit later.

export interface ImageGenResult {
  dataUrl: string
  mimeType: string
}

export interface ImageProvider {
  readonly id: string
  generate(prompt: string): Promise<ImageGenResult>
}

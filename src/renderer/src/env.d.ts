/// <reference types="vite/client" />

// requestVideoFrameCallback is not yet in the standard TS DOM lib; declare it so
// the sync engine can measure the actually-presented frame time per camera.
interface VideoFrameCallbackMetadata {
  presentationTime: number
  expectedDisplayTime: number
  width: number
  height: number
  mediaTime: number
  presentedFrames: number
  processingDuration?: number
  captureTime?: number
  receiveTime?: number
  rtpTimestamp?: number
}

interface HTMLVideoElement {
  requestVideoFrameCallback(
    callback: (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void
  ): number
  cancelVideoFrameCallback(handle: number): void
}

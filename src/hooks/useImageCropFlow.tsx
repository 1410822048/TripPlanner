// src/hooks/useImageCropFlow.ts
// Crop-before-commit flow for any form modal that accepts user-picked
// images. Encapsulates the state machine + blob URL lifecycle + dialog
// render that WishFormModal and BookingFormModal previously each
// reinvented.
//
// Usage:
//   const crop = useImageCropFlow(att.pickFile)
//   // in your file <input> onChange:
//   crop.intercept(file)
//   // in JSX:
//   {crop.dialog}
//
// Behaviour:
//   - File is an image → opens ImageCropDialog, runs cropImage() on
//     confirm, calls onCropped(croppedFile)
//   - File is a PDF / HEIC / anything non-image → onCropped(file)
//     directly (no dialog, no canvas slicing)
//   - User cancels → no callback fires, picked file discarded
//
// Why return the dialog as a ReactNode (rather than a props bag):
// it's only ever paired with ImageCropDialog. Returning the JSX
// directly keeps the caller from re-importing the component and
// re-wiring src / handlers — same shape every time.
import { useState, type ReactNode } from 'react'
import ImageCropDialog from '@/components/ui/ImageCropDialog'
import { cropImage, type PixelCrop } from '@/utils/image'
import { useBlobUrl } from './useBlobUrl'

export interface UseImageCropFlowResult {
  /** Feed any picked File. Images route through the crop dialog;
   *  everything else is forwarded straight to `onCropped`. */
  intercept: (file: File) => void
  /** Drop into JSX. Null while no file is awaiting crop. */
  dialog:    ReactNode
}

export function useImageCropFlow(
  onCropped: (file: File) => void,
): UseImageCropFlowResult {
  const [pending, setPending] = useState<File | null>(null)

  // Blob URL for the picked file — feeds react-easy-crop. Lifecycle
  // (create + auto-revoke on change / unmount) lives in useBlobUrl.
  const url = useBlobUrl(pending)

  function intercept(file: File) {
    if (file.type.startsWith('image/')) setPending(file)
    else onCropped(file)
  }

  async function handleConfirm(area: PixelCrop) {
    if (!pending) return
    const cropped = await cropImage(pending, area)
    setPending(null)
    onCropped(cropped)
  }

  const dialog = url
    ? <ImageCropDialog src={url} onCancel={() => setPending(null)} onConfirm={handleConfirm} />
    : null

  return { intercept, dialog }
}

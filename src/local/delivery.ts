import { randomBytes } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { FileSink } from '../audio/sink.js';
import type { Delivery, DeliveryRequest, PendingAudio } from '../delivery.js';
import { OutputPathError, placeFile, resolveOutputPath } from './files.js';

/**
 * Local mode: audio becomes a file on this machine; the result carries its
 * absolute path. Audio is written to a hidden temporary file beside the target
 * and moved into place when complete, so a partial file is never left behind.
 */
export function createLocalDelivery(outputDir: string): Delivery {
  const base = path.resolve(outputDir);
  return {
    async begin(request: DeliveryRequest): Promise<PendingAudio> {
      let target: string;
      if (request.outputPath === undefined) {
        await mkdir(base, { recursive: true });
        target = path.join(base, request.fileName);
      } else {
        target = await resolveOutputPath({
          outputDir: base,
          outputPath: request.outputPath,
          extensions: request.acceptedExtensions,
        });
        const existing = await lstat(target).catch(() => undefined);
        if (existing?.isDirectory()) throw new OutputPathError(`${target} is a directory.`);
        if (existing && !request.overwrite) {
          // Checked again atomically when the file is placed; failing here avoids spending credits.
          throw new OutputPathError(
            `${target} already exists. Set overwrite to true to replace it, or choose another path.`,
          );
        }
      }
      const temp = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${randomBytes(6).toString('hex')}.part`,
      );
      const sink = await FileSink.create(temp);
      return {
        write: (chunk) => sink.write(chunk),
        writeAt: (chunk, position) => sink.writeAt(chunk, position),
        get bytesWritten() {
          return sink.bytesWritten;
        },
        async commit() {
          await sink.close();
          try {
            await placeFile(temp, target, request.overwrite);
          } catch (error) {
            await sink.discard();
            throw error;
          }
          return { delivered: { file_path: target }, filePath: target };
        },
        discard: () => sink.discard(),
      };
    },
  };
}

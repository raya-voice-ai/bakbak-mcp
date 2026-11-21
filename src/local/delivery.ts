import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Delivery, DeliveryRequest, DeliveryTarget } from '../delivery.js';
import { OutputPathError, resolveOutputPath, writeAudioFile } from './files.js';

/** Local mode: audio becomes a file on this machine; the result carries its absolute path. */
export function createLocalDelivery(outputDir: string): Delivery {
  const base = path.resolve(outputDir);
  return {
    async prepare(request: DeliveryRequest): Promise<DeliveryTarget> {
      if (request.outputPath === undefined) {
        const filePath = path.join(base, request.fileName);
        return {
          async commit(data) {
            await mkdir(base, { recursive: true });
            await writeAudioFile(filePath, data, false);
            return { file_path: filePath };
          },
        };
      }
      const filePath = await resolveOutputPath({
        outputDir: base,
        outputPath: request.outputPath,
        extensions: request.acceptedExtensions,
      });
      const existing = await stat(filePath).catch(() => undefined);
      if (existing && !request.overwrite) {
        // Checked again atomically on write; failing here avoids spending credits first.
        throw new OutputPathError(
          `${filePath} already exists. Set overwrite to true to replace it, or choose another path.`,
        );
      }
      return {
        async commit(data) {
          await writeAudioFile(filePath, data, request.overwrite);
          return { file_path: filePath };
        },
      };
    },
  };
}

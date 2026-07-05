import { Injectable } from '@nestjs/common';
import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';

@Injectable()
export class BarcodePdfService {
  async renderLabels(codes: string[], labelTitle = 'Etiquetas de codigo de barras') {
    return new Promise<Buffer>(async (resolve, reject) => {
      const document = new PDFDocument({
        margin: 32,
        size: 'A4',
      });
      const chunks: Buffer[] = [];

      document.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);

      document.fontSize(18).text(labelTitle, { underline: true });
      document.moveDown();

      let currentY = document.y;

      for (const code of codes) {
        const barcode = await bwipjs.toBuffer({
          bcid: 'code128',
          height: 12,
          includetext: true,
          scale: 2,
          text: code,
        });

        if (currentY > 720) {
          document.addPage();
          currentY = 48;
        }

        document
          .roundedRect(40, currentY, 250, 120, 12)
          .lineWidth(0.6)
          .strokeOpacity(0.25)
          .stroke();
        document.image(barcode, 60, currentY + 20, {
          fit: [210, 64],
        });
        document.fontSize(12).text(code, 60, currentY + 90);

        currentY += 140;
      }

      document.end();
    });
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer from 'puppeteer';
import { PrismaService } from '@/database/prisma.service';

@Injectable()
export class InvoicePdfService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async renderInvoicePdf(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        cashRegister: true,
        customer: true,
        lines: {
          include: {
            product: true,
            variant: {
              include: {
                barcode: true,
                product: true,
              },
            },
          },
        },
        payments: true,
        receivable: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException('Factura no encontrada.');
    }

    const executablePath =
      this.configService.get<string>('PUPPETEER_EXECUTABLE_PATH') || undefined;
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
    });

    try {
      const page = await browser.newPage();
      const rows = invoice.lines
        .map(
          (line) => `
            <tr>
              <td>${line.description}</td>
              <td>${line.barcode}</td>
              <td>${line.quantity}</td>
              <td>$${Number(line.unitPrice).toFixed(2)}</td>
              <td>$${line.lineTotal.toFixed(2)}</td>
            </tr>
          `,
        )
        .join('');

      await page.setContent(
        `
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; padding: 32px; color: #1f2937; }
                h1 { margin-bottom: 8px; }
                table { width: 100%; border-collapse: collapse; margin-top: 24px; }
                th, td { border-bottom: 1px solid #e5e7eb; padding: 10px; text-align: left; }
                .summary { margin-top: 24px; }
                .summary p { margin: 6px 0; }
              </style>
            </head>
            <body>
              <h1>Factura interna ${invoice.sequential}</h1>
              <p>Cliente: ${invoice.customerNameSnapshot}</p>
              <p>Identificacion: ${invoice.customerIdentificationSnapshot}</p>
              <p>Fecha: ${invoice.issuedAt.toISOString()}</p>
              <p>Estado: ${invoice.status}</p>
              <p>Caja: ${invoice.cashRegister?.name ?? 'Sin caja asociada'}</p>
              <table>
                <thead>
                  <tr>
                    <th>Detalle</th>
                    <th>Barcode</th>
                    <th>Cantidad</th>
                    <th>Unitario</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
              <div class="summary">
                <p>Subtotal: $${invoice.subtotal.toFixed(2)}</p>
                <p>Impuestos: $${invoice.taxTotal.toFixed(2)}</p>
                <p>Total: $${invoice.total.toFixed(2)}</p>
                <p>Pagos registrados: $${invoice.payments
                  .reduce((sum, payment) => sum + Number(payment.amount), 0)
                  .toFixed(2)}</p>
                <p>Saldo: $${invoice.receivable?.balance.toFixed(2) ?? '0.00'}</p>
              </div>
            </body>
          </html>
        `,
        { waitUntil: 'networkidle0' },
      );

      return page.pdf({
        format: 'A4',
        margin: {
          bottom: '20px',
          left: '20px',
          right: '20px',
          top: '20px',
        },
      });
    } finally {
      await browser.close();
    }
  }
}

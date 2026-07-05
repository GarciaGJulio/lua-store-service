import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer from 'puppeteer';
import { PrismaService } from '@/database/prisma.service';

@Injectable()
export class ReceiptPdfService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async renderPaymentReceipt(paymentId: string) {
    const payment = await this.prisma.receivablePayment.findUnique({
      where: { id: paymentId },
      include: {
        receivable: {
          include: {
            customer: true,
            invoice: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Pago de cartera no encontrado.');
    }

    const executablePath =
      this.configService.get<string>('PUPPETEER_EXECUTABLE_PATH') || undefined;
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
    });

    try {
      const page = await browser.newPage();

      await page.setContent(
        `
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; padding: 32px; color: #1f2937; }
                .box { border: 1px solid #d1d5db; border-radius: 16px; padding: 24px; }
                h1 { margin-top: 0; }
                p { margin: 8px 0; }
              </style>
            </head>
            <body>
              <div class="box">
                <h1>Comprobante de abono</h1>
                <p>Cliente: ${payment.receivable.customer.fullName}</p>
                <p>Factura: ${payment.receivable.invoice.sequential}</p>
                <p>Comprobante: ${payment.paymentNumber}</p>
                <p>Monto abonado: $${payment.amount.toFixed(2)}</p>
                <p>Metodo: ${payment.method}</p>
                <p>Fecha: ${payment.paidAt.toISOString()}</p>
                <p>Saldo restante: $${payment.receivable.balance.toFixed(2)}</p>
                <p>Notas: ${payment.notes ?? 'Sin notas'}</p>
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

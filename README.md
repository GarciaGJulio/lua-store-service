# Lua Store Service

Backend NestJS preparado para inventario, facturacion, cartera, caja, auditoria y archivos.

## Stack

- NestJS 11
- Prisma + PostgreSQL
- JWT con Passport
- DTOs con `class-validator`
- Swagger en `/docs`
- PDFs con Puppeteer
- Etiquetas/barcodes con PDFKit + `bwip-js`

## Modulos

- `auth`
- `users`
- `categories`
- `subcategories`
- `products`
- `variants`
- `barcodes`
- `taxes`
- `customers`
- `invoices`
- `receivables`
- `cash`
- `analytics`
- `files`
- `settings`
- `audit`

## Arranque

1. Copia `.env.example` a `.env`.
2. Levanta PostgreSQL con el `docker-compose.yml` del directorio raiz o con tu propia instancia.
3. Ejecuta `npm install`.
4. Ejecuta `npm run prisma:generate`.
5. Ejecuta `npm run prisma:push`.
6. Ejecuta `npm run prisma:seed`.
7. Ejecuta `npm run start:dev`.

## Credenciales demo

- Email: `admin@luastore.local`
- Clave: `123456`

## Notas

- La creacion y anulacion de facturas ya estan preparadas con transacciones Prisma.
- Los abonos a cartera tambien actualizan saldo, factura, caja y auditoria en una sola transaccion.
- Si quieres generar PDFs con Puppeteer en Windows, define `PUPPETEER_EXECUTABLE_PATH` en `.env` apuntando a tu instalacion local de Chrome o Edge.

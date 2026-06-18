This is a [Next.js](https://nextjs.org) project bootstrapped with
[`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the
result.

## Submitting shipments to Skyline Axis

Parsed DHL SameDay / Sky Courier dispatch tickets can be submitted to Skyline's
Xcelerator **ClientPortal** as new Axis orders, in addition to generating the
filled Air Waybill / IAC PDFs.

- Client: [`src/lib/axis.ts`](src/lib/axis.ts) logs in to ClientPortal with the caller username/password, opens `NewOrder`, validates the order, and posts `newOrderOnline/SubmitOrder`.
- Mapping: [`src/lib/axis-map.ts`](src/lib/axis-map.ts) turns a parsed ticket into an order draft: shipper -> pickup, consignee -> delivery, references, routing summary, and package details.
- Route: [`src/app/api/axis-submit/route.ts`](src/app/api/axis-submit/route.ts) validates config, builds drafts, and calls the portal client.
- UI: each parsed ticket gets a **Submit to Axis** button, plus a **Submit all to Axis** action.

### Configuration

Copy [`.env.example`](.env.example) to `.env.local` and fill it in. This caller
does not use an API key or Swagger Bearer token; it uses the same session-backed
portal flow as `https://skylinecourierlogistics.com/xcelerator/clientportal`.

Set `AXIS_USERNAME` and `AXIS_PASSWORD`. `AXIS_ACCOUNT_NO`,
`AXIS_SERVICE_ID`, and `AXIS_VEHICLE_ID` are optional but useful for explicit
previews. If service or vehicle is blank, the app reads the caller defaults from
ClientPortal. If `AXIS_PACKAGE_ID` is blank, the app uses the portal default
package type when submitting structured pieces, weight, and dimensions.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the
[Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app)
from the creators of Next.js.

Check out the [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying)
for more details.

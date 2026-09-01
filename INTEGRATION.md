# OrdersPage integration

Surgical patches. Nothing outside the listed anchors changes.

## 0. Files to copy

```
frontend/epost.ts              → src/lib/epost.ts
frontend/countryResolver.ts    → src/lib/countryResolver.ts
frontend/epostOrderAdapter.ts  → src/lib/epostOrderAdapter.ts
```

`.env.local` and Vercel:

```
VITE_EPOST_PROXY_URL=https://api.standardtime.watch/api/epost
VITE_EPOST_PROXY_KEY=<PROXY_SHARED_SECRET>
```

## 1. Database — already applied

Migration `add_epost_shipment_fields_to_orders` ran against
`rbhkzknwpzfuhccqybko`. It is additive: 22 new columns, 3 check constraints, 2
partial indexes. No existing column was altered.

New columns: `shipping_weight_g`, `box_length_cm`, `box_width_cm`,
`box_height_cm`, `epost_hs_code`, `epost_origin_country`, `epost_country_code`,
`epost_premium_cd`, `epost_mail_kind`, `epost_reserve_no`, `epost_receive_seq`,
`epost_postage_krw`, `epost_pay_method`, `epost_office_code`,
`epost_office_name`, `epost_exchange_office`, `epost_created_at`,
`epost_confirmed_at`, `epost_cancelled_at`, `epost_last_error`, `epost_request`,
`epost_is_live`.

## 2. `src/pages/OrdersPage.tsx` — Order interface

**Find** (around line 344, end of the interface):

```ts
  payment_link_token?: string | null;
  payment_status?: string | null;
}
```

**Replace with:**

```ts
  payment_link_token?: string | null;
  payment_status?: string | null;
  // epost EMS/K-Packet
  epost_country_code?: string | null;
  epost_premium_cd?: string | null;
  epost_mail_kind?: string | null;
  epost_hs_code?: string | null;
  epost_origin_country?: string | null;
  shipping_weight_g?: number | null;
  box_length_cm?: number | null;
  box_width_cm?: number | null;
  box_height_cm?: number | null;
  epost_reserve_no?: string | null;
  epost_receive_seq?: string | null;
  epost_postage_krw?: number | null;
  epost_is_live?: boolean | null;
  epost_created_at?: string | null;
  epost_confirmed_at?: string | null;
  epost_cancelled_at?: string | null;
  epost_last_error?: string | null;
}
```

## 3. Imports

**Find** the existing import block at the top and **add**:

```ts
import { useShipmentSubmit, cancelShipment, getShipmentStatus, PremiumCode } from '../lib/epost';
import { adaptOrderToShipment, shipmentResultToOrderUpdate } from '../lib/epostOrderAdapter';
```

## 4. Shipment creation handler

**Find:**

```ts
  const saveTracking = async (orderId: string) => {
    const ok = await updateOrder(orderId, { tracking_number: tempTracking.number, tracking_url: tempTracking.url, shipping_courier: shippingCourier });
    if (ok) setEditingTracking(null);
  };
```

**Insert immediately after it:**

```ts
  // EMS Premium 접수신청. Creates the shipment at epost and writes the resulting
  // 등기번호 back onto the order, so the existing shipped-email template and
  // buyer view pick it up unchanged.
  const [epostBusy, setEpostBusy] = useState<string | null>(null);
  const [epostIssues, setEpostIssues] = useState<Record<string, string[]>>({});

  const createEmsShipment = async (order: Order) => {
    const { input, missing, assumed } = adaptOrderToShipment(order as any);

    if (!input) {
      setEpostIssues({ [order.id]: missing.map((m) => `${m.field}: ${m.reason}`) });
      return;
    }

    // Assumptions land on a customs declaration, so they get confirmed, not hidden.
    if (assumed.length) {
      const lines = assumed.map((a) => `· ${a.field} = ${a.value}\n  ${a.reason}`).join('\n');
      if (!window.confirm(`다음 값은 주문 데이터가 아니라 기본값입니다:\n\n${lines}\n\n이대로 접수할까요?`)) return;
    }

    setEpostBusy(order.id);
    setEpostIssues({});
    try {
      const res = await submitShipment(input);
      if (!res) return; // issues are surfaced by the hook

      await updateOrder(order.id, shipmentResultToOrderUpdate(res) as any);

      if (!res.live) {
        alert(
          `테스트 접수입니다. 등기번호 ${res.trackingNumber} 는 실제 우편물이 아니며 ` +
          `우체국에 전송되지 않았습니다. 고객에게 발송 안내를 보내지 마세요.`,
        );
      }
    } finally {
      setEpostBusy(null);
    }
  };

  const cancelEmsShipment = async (order: Order) => {
    if (!order.epost_reserve_no || !order.tracking_number) {
      alert('예약번호 또는 등기번호가 없어 취소할 수 없습니다.');
      return;
    }
    if (!window.confirm(`${order.tracking_number} 접수를 취소할까요?`)) return;

    setEpostBusy(order.id);
    try {
      const res = await cancelShipment({ reqno: order.epost_reserve_no, regino: order.tracking_number });
      if (res.cancelled) {
        await updateOrder(order.id, {
          epost_cancelled_at: new Date().toISOString(),
          tracking_number: null, tracking_url: null,
        } as any);
      } else {
        // canceledyn='N' means the post office already took the parcel.
        alert(`취소 불가: ${res.reason ?? '우체국 접수 완료'}`);
        await updateOrder(order.id, { epost_confirmed_at: new Date().toISOString() } as any);
      }
    } finally {
      setEpostBusy(null);
    }
  };
```

Then **add the hook** next to the other `useState` declarations near the top of
the component:

```ts
  const { submit: submitShipment, issues: shipmentIssues, error: shipmentError } = useShipmentSubmit();
```

## 5. Button in the order row

**Find** (around line 2789, the existing tracking button):

```tsx
                                    <button className="op-btn op-btn-secondary op-body" onClick={() => { setEditingTracking(order.id); setTempTracking({ number: order.tracking_number || '', url: order.tracking_url || '' }); setShippingCourier(order.shipping_courier || ''); }}>
                                      <Truck style={{ width: '12px', height: '12px' }} /> {order.tracking_number ? `${order.shipping_courier ? order.shipping_courier + ': ' : ''}${order.tracking_number} — Edit` : 'Add Tracking'}
```

**Add directly above that button:**

```tsx
                                    {isAdmin && !order.tracking_number && (
                                      <button
                                        className="op-btn op-btn-secondary op-body"
                                        disabled={epostBusy === order.id}
                                        onClick={() => createEmsShipment(order)}
                                      >
                                        <Truck style={{ width: '12px', height: '12px' }} />
                                        {epostBusy === order.id ? '접수 중…' : 'EMS 프리미엄 접수'}
                                      </button>
                                    )}
                                    {isAdmin && order.epost_is_live === false && (
                                      <span style={{ fontSize: '11px', color: '#b45309', fontWeight: 600 }}>
                                        TEST 접수 — 실제 발송 아님
                                      </span>
                                    )}
                                    {isAdmin && order.epost_reserve_no && !order.epost_confirmed_at && !order.epost_cancelled_at && (
                                      <button
                                        className="op-btn op-btn-secondary op-body"
                                        disabled={epostBusy === order.id}
                                        onClick={() => cancelEmsShipment(order)}
                                      >
                                        접수 취소
                                      </button>
                                    )}
                                    {(epostIssues[order.id] ?? []).map((msg) => (
                                      <div key={msg} style={{ fontSize: '11px', color: '#b91c1c' }}>{msg}</div>
                                    ))}
                                    {shipmentIssues.map((i) => (
                                      <div key={i.field} style={{ fontSize: '11px', color: i.severity === 'warning' ? '#b45309' : '#b91c1c' }}>
                                        {i.field}: {i.message}
                                      </div>
                                    ))}
                                    {shipmentError && (
                                      <div style={{ fontSize: '11px', color: '#b91c1c' }}>{shipmentError}</div>
                                    )}
```

The `epost_is_live === false` badge is the important one. A DEV 등기번호 is
well-formed (`PW…KR` for EMS Premium) and looks identical to a real one in the
orders list. Without the badge, a test shipment eventually gets emailed to a
customer as real tracking.

## 6. What still needs a UI

The adapter defaults weight to 1200g and the box to 30×22×15cm, and reports both
through `assumed` — the confirm dialog above surfaces them. That is a stopgap.
Postage bills on the greater of actual and volumetric weight, so guessing costs
real money on every shipment.

The proper fix is four number inputs on the order row writing to
`shipping_weight_g`, `box_length_cm`, `box_width_cm`, `box_height_cm`. Once
those are populated the confirm dialog stops appearing, because nothing is being
assumed any more.

Same for `epost_country_code`: the adapter refuses to ship until it is set, even
when the resolver is confident, because a wrong country is a watch on the wrong
continent. A two-letter input or a dropdown next to the destination, prefilled
from `resolveCountry(order.shipping_country)`, makes that one click.

## 7. Recommended order of work

1. Copy the three files, add the env vars.
2. Patch the `Order` interface and imports (steps 2–3).
3. Run `npm run probe:api` on the Lightsail box and confirm the parsers.
4. Patch the handlers and button (steps 4–5) with `EPOST_LIVE` unset.
5. Create a shipment on a real order in DEV mode. Confirm the `PW…KR` number and
   the TEST badge appear, then cancel it.
6. Add the weight/dimension inputs (step 6).
7. Only then set `EPOST_LIVE=1`.

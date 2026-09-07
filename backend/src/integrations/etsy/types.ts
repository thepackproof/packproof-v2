export interface EtsyMoney {
  amount: number;
  divisor: number;
  currency_code: string;
}

export interface EtsyReceiptTransaction {
  transaction_id: string;
  receipt_id: string;
  seller_user_id: string;
  title: string | null;
  sku: string | null;
  quantity: number;
  is_digital: boolean | null;
  shipped_timestamp: number | null;
  price: EtsyMoney | null;
  variations: Array<{ formatted_name: string; formatted_value: string }>;
}

export interface EtsyReceiptShipment {
  receipt_shipping_id: string | null;
  shipment_notification_timestamp: number | null;
  carrier_name: string | null;
  tracking_code: string | null;
}

/** Deliberately excludes addresses, buyer email and private buyer/seller messages. */
export interface EtsyReceipt {
  receipt_id: string;
  seller_user_id: string;
  buyer_user_id: string | null;
  status: string;
  is_paid: boolean | null;
  is_shipped: boolean | null;
  create_timestamp: number;
  update_timestamp: number;
  grandtotal: EtsyMoney | null;
  transactions: EtsyReceiptTransaction[];
  shipments: EtsyReceiptShipment[];
  refundCount: number;
}

export interface EtsyReceiptPage {
  receipts: EtsyReceipt[];
  total: number;
  limit: number;
  offset: number;
}

export interface EtsyShopIdentity { shopId: string; userId: string; shopName: string }

export interface EtsyTokenSet {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresInSeconds: number;
  /** Null means Etsy omitted scope; an explicit subset must never be widened. */
  scopes: string[] | null;
}

export interface EtsyClient {
  exchangeAuthorizationCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<EtsyTokenSet>;
  refreshUserToken(input: { refreshToken: string }): Promise<EtsyTokenSet>;
  getShop(input: { accessToken: string }): Promise<EtsyShopIdentity>;
  listReceipts(input: {
    accessToken: string;
    shopId: string;
    limit?: number;
    offset?: number;
    minLastModified?: string;
    maxLastModified?: string;
    wasPaid?: boolean;
    wasShipped?: boolean;
  }): Promise<EtsyReceiptPage>;
  getReceipt(input: { accessToken: string; shopId: string; receiptId: string }): Promise<EtsyReceipt>;
}

export interface IntakePreview {
  requiresConfirmation: true;
  warnings: string[];
  draft: {
    externalReference: string | null;
    itemTitle: string | null;
    quantity: number | null;
    transactionValue: number | null;
    currency: string | null;
    shipping: { carrier: string | null; trackingNumber: string | null };
    metadata: {
      intake: {
        source: string;
        sourceSha256: string;
        confirmed: boolean;
        marketplace: string | null;
        buyer: string | null;
        seller: string | null;
      };
    };
  };
}

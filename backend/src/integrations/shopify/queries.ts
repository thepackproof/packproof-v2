// Admin GraphQL 2026-07. Keep order and nested connection pagination independent
// so requested query cost does not multiply orders × lines × fulfillments.
export const SHOP_IDENTITY_QUERY = `query PackProofShopIdentity {
  shop { id name myshopifyDomain }
}`;

export const ORDERS_QUERY = `query PackProofOrders($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes { id updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

const LINE_FIELDS = `id title sku quantity currentQuantity unfulfilledQuantity variantTitle requiresShipping
  originalUnitPriceSet { shopMoney { amount currencyCode } }`;

export const ORDER_QUERY = `query PackProofOrder($id: ID!) {
  order(id: $id) {
    id legacyResourceId name createdAt updatedAt cancelledAt test
    displayFinancialStatus displayFulfillmentStatus
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    lineItems(first: 100) {
      nodes { ${LINE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
    fulfillments { id legacyResourceId updatedAt status trackingInfo { company number } }
  }
}`;

export const ORDER_LINES_QUERY = `query PackProofOrderLines($id: ID!, $after: String!) {
  order(id: $id) {
    id updatedAt
    lineItems(first: 100, after: $after) {
      nodes { ${LINE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const FULFILLMENT_LINES_QUERY = `query PackProofFulfillmentLines($id: ID!, $after: String) {
  node(id: $id) {
    ... on Fulfillment {
      id updatedAt
      fulfillmentLineItems(first: 100, after: $after) {
        nodes { id quantity lineItem { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const ASSIGNMENT_FIELDS = `deliveryMethod { methodType }
  assignedLocation { location { isFulfillmentService } }`;

// Shopify filters by granted scopes, which can include permissions from an
// older installation. Always verify the actual assigned location as well.
export const ORDER_FULFILLMENT_ORDERS_QUERY = `query PackProofOrderFulfillmentOrders($id: ID!, $after: String) {
  order(id: $id) {
    id updatedAt
    fulfillmentOrders(first: 100, after: $after) {
      nodes { id updatedAt status requestStatus ${ASSIGNMENT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const FULFILLMENT_ORDER_LINES_QUERY = `query PackProofFulfillmentOrderLines($id: ID!, $after: String) {
  node(id: $id) {
    ... on FulfillmentOrder {
      id updatedAt
      lineItems(first: 100, after: $after) {
        nodes { id remainingQuantity requiresShipping lineItem { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export const FULFILLMENT_ORDER_REVISION_QUERY = `query PackProofFulfillmentOrderRevision($id: ID!) {
  node(id: $id) { ... on FulfillmentOrder { id updatedAt ${ASSIGNMENT_FIELDS} } }
}`;

export const ORDER_REVISION_QUERY = `query PackProofOrderRevision($id: ID!) {
  order(id: $id) { id updatedAt }
}`;

export const UNINSTALL_MUTATION = `mutation PackProofUninstall {
  appUninstall { app { id } userErrors { field message } }
}`;

/** Optional product fields only when this connection already has read_products/write_products. */
export const identifierOrderQuery = (query:string,enabled=false):string => enabled ? query.replace(/requiresShipping/g, "requiresShipping variant { id barcode product { id } }") : query;

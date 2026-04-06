--
-- PostgreSQL database dump
--

\restrict fEK7yH9YMeOsXjcZXdDbaxZtzXb8OhCDLiTVPg6rPChI4CXoCgoz6U7DekZB9RT

-- Dumped from database version 17.9 (Debian 17.9-0+deb13u1)
-- Dumped by pg_dump version 17.9 (Debian 17.9-0+deb13u1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'SQL_ASCII';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ActivityEntityType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ActivityEntityType" AS ENUM (
    'USER',
    'PRODUCT',
    'WAREHOUSE',
    'SUPPLIER',
    'PURCHASE_ORDER',
    'SALES_ORDER',
    'STOCK_TRANSFER',
    'STOCK_COUNT',
    'PRODUCTION_ORDER',
    'SETTING',
    'IMPORT',
    'CUSTOMER',
    'STOCK_ADJUSTMENT',
    'SYNC',
    'CURRENCY',
    'SYSTEM'
);


--
-- Name: ActivityLogLevel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ActivityLogLevel" AS ENUM (
    'INFO',
    'WARNING',
    'ERROR'
);


--
-- Name: CurrencyType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CurrencyType" AS ENUM (
    'SALES',
    'PURCHASE',
    'BOTH'
);


--
-- Name: LandedCostMethod; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."LandedCostMethod" AS ENUM (
    'BY_VALUE',
    'BY_WEIGHT',
    'BY_QUANTITY',
    'EQUAL_SPLIT'
);


--
-- Name: ProductType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ProductType" AS ENUM (
    'SIMPLE',
    'VARIABLE',
    'VARIANT',
    'KIT',
    'NON_INVENTORY',
    'BOM'
);


--
-- Name: ProductionOrderStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ProductionOrderStatus" AS ENUM (
    'DRAFT',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED'
);


--
-- Name: ProductionOrderType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ProductionOrderType" AS ENUM (
    'ASSEMBLY',
    'DISASSEMBLY'
);


--
-- Name: PurchaseOrderStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PurchaseOrderStatus" AS ENUM (
    'DRAFT',
    'RFQ_SENT',
    'PO_SENT',
    'PARTIALLY_RECEIVED',
    'RECEIVED',
    'INVOICED',
    'PARTIALLY_RETURNED',
    'RETURNED',
    'CANCELLED'
);


--
-- Name: PurchaseOrderType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PurchaseOrderType" AS ENUM (
    'GOODS',
    'FREIGHT'
);


--
-- Name: SalesOrderStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."SalesOrderStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'PICKING',
    'PACKED',
    'SHIPPED',
    'COMPLETED',
    'CANCELLED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'ON_HOLD'
);


--
-- Name: StockCountStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."StockCountStatus" AS ENUM (
    'DRAFT',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED'
);


--
-- Name: StockMovementType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."StockMovementType" AS ENUM (
    'PURCHASE_RECEIPT',
    'SALE_DISPATCH',
    'RETURN_INBOUND',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'ADJUSTMENT',
    'PRODUCTION_IN',
    'PRODUCTION_OUT',
    'KIT_ASSEMBLY_IN',
    'KIT_ASSEMBLY_OUT',
    'OPENING_STOCK'
);


--
-- Name: StockTransferStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."StockTransferStatus" AS ENUM (
    'DRAFT',
    'IN_TRANSIT',
    'RECEIVED',
    'CANCELLED'
);


--
-- Name: TaxType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TaxType" AS ENUM (
    'VAT',
    'GST',
    'NONE'
);


--
-- Name: UserRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."UserRole" AS ENUM (
    'ADMIN',
    'WAREHOUSE',
    'FINANCE',
    'READONLY'
);


--
-- Name: WarehouseType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."WarehouseType" AS ENUM (
    'STANDARD',
    'QUARANTINE',
    'RESTOCK'
);


--
-- Name: WcSyncDirection; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."WcSyncDirection" AS ENUM (
    'TO_WC',
    'FROM_WC'
);


--
-- Name: WcSyncStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."WcSyncStatus" AS ENUM (
    'PENDING',
    'SYNCED',
    'FAILED'
);


--
-- Name: XeroSyncStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."XeroSyncStatus" AS ENUM (
    'PENDING',
    'SYNCED',
    'FAILED'
);


--
-- Name: XeroSyncType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."XeroSyncType" AS ENUM (
    'PURCHASE_INVOICE',
    'COGS_JOURNAL',
    'INVENTORY_ADJUSTMENT'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


--
-- Name: activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_logs (
    id text NOT NULL,
    "userId" text,
    "entityType" public."ActivityEntityType" NOT NULL,
    "entityId" text,
    action text NOT NULL,
    description text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    level public."ActivityLogLevel" DEFAULT 'INFO'::public."ActivityLogLevel" NOT NULL,
    tag text NOT NULL
);


--
-- Name: adjustment_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.adjustment_reasons (
    id text NOT NULL,
    name text NOT NULL,
    "xeroAccountCode" text,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: bom_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bom_items (
    id text NOT NULL,
    "bomId" text NOT NULL,
    "parentProductId" text NOT NULL,
    "componentProductId" text NOT NULL,
    qty numeric(12,4) NOT NULL,
    notes text,
    "sortOrder" integer DEFAULT 0 NOT NULL
);


--
-- Name: boms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boms (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: cogs_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cogs_entries (
    id text NOT NULL,
    "costLayerId" text NOT NULL,
    "movementId" text NOT NULL,
    qty numeric(12,4) NOT NULL,
    "unitCostGbp" numeric(18,6) NOT NULL,
    "totalCostGbp" numeric(18,6) NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: cost_layers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_layers (
    id text NOT NULL,
    "productId" text NOT NULL,
    "warehouseId" text NOT NULL,
    "receivedQty" numeric(12,4) NOT NULL,
    "remainingQty" numeric(12,4) NOT NULL,
    "unitCostGbp" numeric(18,6) NOT NULL,
    "receivedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "poLineId" text,
    "isOpeningStock" boolean DEFAULT false NOT NULL
);


--
-- Name: currencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.currencies (
    code text NOT NULL,
    name text NOT NULL,
    symbol text NOT NULL,
    "usedFor" public."CurrencyType" DEFAULT 'BOTH'::public."CurrencyType" NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id text NOT NULL,
    email text,
    phone text,
    company text,
    "billingAddress" jsonb,
    "shippingAddress" jsonb,
    notes text,
    "wcCustomerId" integer,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "firstName" text NOT NULL,
    "lastName" text NOT NULL,
    "taxNumber" text
);


--
-- Name: document_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_templates (
    id text NOT NULL,
    type text NOT NULL,
    "headerNote" text,
    "footerNote" text,
    "termsText" text,
    "showLogo" boolean DEFAULT true NOT NULL,
    "showVat" boolean DEFAULT true NOT NULL,
    "showPaymentTerms" boolean DEFAULT false NOT NULL,
    "paymentTermsText" text,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "customFooter" text
);


--
-- Name: freight_cost_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.freight_cost_lines (
    id text NOT NULL,
    "poId" text NOT NULL,
    description text NOT NULL,
    "amountForeign" numeric(18,4) NOT NULL,
    "amountGbp" numeric(18,4) NOT NULL,
    vatable boolean DEFAULT false NOT NULL,
    "distributionMethod" public."LandedCostMethod" DEFAULT 'BY_VALUE'::public."LandedCostMethod" NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL
);


--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_rates (
    id text NOT NULL,
    "fromCurrency" text NOT NULL,
    "toCurrency" text NOT NULL,
    rate numeric(18,8) NOT NULL,
    "fetchedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: kit_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_items (
    id text NOT NULL,
    "kitId" text NOT NULL,
    "parentProductId" text NOT NULL,
    "componentProductId" text NOT NULL,
    qty numeric(12,4) NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL
);


--
-- Name: kits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kits (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: landed_cost_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landed_cost_links (
    id text NOT NULL,
    "primaryPoId" text NOT NULL,
    "freightPoId" text NOT NULL,
    method public."LandedCostMethod" DEFAULT 'BY_VALUE'::public."LandedCostMethod" NOT NULL,
    allocated boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: organisations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organisations (
    id text NOT NULL,
    name text NOT NULL,
    "legalName" text,
    "vatNumber" text,
    "companyNumber" text,
    "addressLine1" text,
    "addressLine2" text,
    city text,
    county text,
    postcode text,
    country text DEFAULT 'GB'::text NOT NULL,
    phone text,
    email text,
    website text,
    "logoUrl" text,
    "baseCurrency" text DEFAULT 'GBP'::text NOT NULL,
    "financialYearStartMonth" integer DEFAULT 5 NOT NULL,
    "financialYearStartDay" integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "documentLogoUrl" text
);


--
-- Name: passkeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passkeys (
    id text NOT NULL,
    "userId" text NOT NULL,
    "credentialId" text NOT NULL,
    "credentialPublicKey" bytea NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports text[],
    name text DEFAULT 'Passkey'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "refundId" text,
    amount numeric(18,4) NOT NULL,
    currency text DEFAULT 'GBP'::text NOT NULL,
    method text,
    reference text,
    notes text,
    "paidAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: product_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_components (
    id text NOT NULL,
    "productId" text NOT NULL,
    "componentId" text NOT NULL,
    qty numeric(12,4) NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL
);


--
-- Name: product_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_options (
    id text NOT NULL,
    "productId" text NOT NULL,
    name text NOT NULL,
    "values" text NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL
);


--
-- Name: production_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_orders (
    id text NOT NULL,
    reference text NOT NULL,
    "bomId" text NOT NULL,
    "outputProductId" text NOT NULL,
    "warehouseId" text NOT NULL,
    "qtyPlanned" numeric(12,4) NOT NULL,
    "qtyProduced" numeric(12,4) DEFAULT 0 NOT NULL,
    status public."ProductionOrderStatus" DEFAULT 'DRAFT'::public."ProductionOrderStatus" NOT NULL,
    "scheduledAt" timestamp(3) without time zone,
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "manufacturerId" text,
    "orderType" public."ProductionOrderType" DEFAULT 'ASSEMBLY'::public."ProductionOrderType" NOT NULL
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id text NOT NULL,
    sku text NOT NULL,
    name text NOT NULL,
    description text,
    type public."ProductType" DEFAULT 'SIMPLE'::public."ProductType" NOT NULL,
    "parentId" text,
    barcode text,
    weight numeric(10,4),
    active boolean DEFAULT true NOT NULL,
    "salesPriceGbp" numeric(12,4),
    "salesPriceTaxInclusive" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "imageUrl" text,
    "depthCm" numeric(10,2),
    "heightCm" numeric(10,2),
    "widthCm" numeric(10,2),
    "salePriceGbp" numeric(12,4),
    "oversellAllowed" boolean DEFAULT true NOT NULL,
    "stockUnit" text DEFAULT 'pcs'::text NOT NULL
);


--
-- Name: purchase_invoice_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_invoice_lines (
    id text NOT NULL,
    "invoiceId" text NOT NULL,
    "poLineId" text NOT NULL,
    "qtyBilled" numeric(12,4) NOT NULL,
    "unitCostForeign" numeric(18,6) NOT NULL,
    "totalForeign" numeric(18,4) NOT NULL,
    "totalGbp" numeric(18,4) NOT NULL
);


--
-- Name: purchase_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_invoices (
    id text NOT NULL,
    "poId" text NOT NULL,
    "invoiceNumber" text,
    "invoiceDate" timestamp(3) without time zone NOT NULL,
    "dueDate" timestamp(3) without time zone,
    "totalForeign" numeric(18,4) NOT NULL,
    "totalGbp" numeric(18,4) NOT NULL,
    "fxRateToGbp" numeric(18,8) NOT NULL,
    notes text,
    "xeroInvoiceId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "subtotalForeign" numeric(18,4) DEFAULT 0 NOT NULL,
    "subtotalGbp" numeric(18,4) DEFAULT 0 NOT NULL,
    "taxForeign" numeric(18,4) DEFAULT 0 NOT NULL,
    "taxGbp" numeric(18,4) DEFAULT 0 NOT NULL,
    "supplierInvoiceUrl" text
);


--
-- Name: purchase_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_order_lines (
    id text NOT NULL,
    "poId" text NOT NULL,
    "productId" text NOT NULL,
    description text,
    qty numeric(12,4) NOT NULL,
    "unitCostForeign" numeric(18,6) NOT NULL,
    "unitCostGbp" numeric(18,6) NOT NULL,
    "taxRateId" text,
    "taxForeign" numeric(18,4) DEFAULT 0 NOT NULL,
    "taxGbp" numeric(18,4) DEFAULT 0 NOT NULL,
    "totalForeign" numeric(18,4) NOT NULL,
    "totalGbp" numeric(18,4) NOT NULL,
    "landedUnitCostGbp" numeric(18,6) DEFAULT 0 NOT NULL,
    "qtyReceived" numeric(12,4) DEFAULT 0 NOT NULL,
    "qtyReturned" numeric(12,4) DEFAULT 0 NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "purchaseUnitId" text,
    "purchaseUnitQty" numeric(12,4)
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id text NOT NULL,
    reference text NOT NULL,
    type public."PurchaseOrderType" DEFAULT 'GOODS'::public."PurchaseOrderType" NOT NULL,
    "supplierId" text NOT NULL,
    status public."PurchaseOrderStatus" DEFAULT 'DRAFT'::public."PurchaseOrderStatus" NOT NULL,
    currency text NOT NULL,
    "fxRateToGbp" numeric(18,8) NOT NULL,
    "subtotalForeign" numeric(18,4) NOT NULL,
    "subtotalGbp" numeric(18,4) NOT NULL,
    "taxForeign" numeric(18,4) DEFAULT 0 NOT NULL,
    "taxGbp" numeric(18,4) DEFAULT 0 NOT NULL,
    "totalForeign" numeric(18,4) NOT NULL,
    "totalGbp" numeric(18,4) NOT NULL,
    "directFreightForeign" numeric(18,4) DEFAULT 0 NOT NULL,
    "directFreightGbp" numeric(18,4) DEFAULT 0 NOT NULL,
    "landedCostMethod" public."LandedCostMethod" DEFAULT 'BY_VALUE'::public."LandedCostMethod" NOT NULL,
    notes text,
    "internalNotes" text,
    "supplierRef" text,
    "expectedDelivery" timestamp(3) without time zone,
    "receivedAt" timestamp(3) without time zone,
    "invoicedAt" timestamp(3) without time zone,
    "rfqSentAt" timestamp(3) without time zone,
    "poSentAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "destinationWarehouseId" text,
    "taxRateName" text,
    "taxRatePercent" numeric(5,4)
);


--
-- Name: purchase_receipt_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_receipt_lines (
    id text NOT NULL,
    "receiptId" text NOT NULL,
    "poLineId" text NOT NULL,
    "qtyReceived" numeric(12,4) NOT NULL,
    "warehouseId" text
);


--
-- Name: purchase_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_receipts (
    id text NOT NULL,
    "poId" text NOT NULL,
    reference text,
    "receivedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: purchase_return_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_return_lines (
    id text NOT NULL,
    "returnId" text NOT NULL,
    "poLineId" text NOT NULL,
    "qtyReturned" numeric(12,4) NOT NULL,
    "warehouseId" text
);


--
-- Name: purchase_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_returns (
    id text NOT NULL,
    "poId" text NOT NULL,
    reference text,
    "returnedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    reason text,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: purchase_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_units (
    id text NOT NULL,
    name text NOT NULL,
    abbreviation text NOT NULL,
    "conversionFactor" numeric(12,4) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "stockUnitName" text DEFAULT 'pcs'::text NOT NULL
);


--
-- Name: sales_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_order_lines (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "productId" text,
    "wcLineItemId" integer,
    description text NOT NULL,
    sku text,
    qty numeric(12,4) NOT NULL,
    "unitPriceForeign" numeric(18,6) NOT NULL,
    "unitPriceGbp" numeric(18,6) NOT NULL,
    "taxRateId" text,
    "taxForeign" numeric(18,4) DEFAULT 0 NOT NULL,
    "taxGbp" numeric(18,4) DEFAULT 0 NOT NULL,
    "totalForeign" numeric(18,4) NOT NULL,
    "totalGbp" numeric(18,4) NOT NULL,
    "cogsGbp" numeric(18,4),
    "discountStr" text,
    "discountAmount" numeric(18,4) DEFAULT 0 NOT NULL
);


--
-- Name: sales_order_refund_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_order_refund_lines (
    id text NOT NULL,
    "refundId" text NOT NULL,
    "productId" text,
    description text NOT NULL,
    qty numeric(12,4) NOT NULL,
    "unitPriceGbp" numeric(18,6) NOT NULL,
    "totalGbp" numeric(18,4) NOT NULL
);


--
-- Name: sales_order_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_order_refunds (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "wcRefundId" integer,
    "returnWarehouseId" text,
    reason text,
    "totalForeign" numeric(18,4) NOT NULL,
    "totalGbp" numeric(18,4) NOT NULL,
    "refundedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "creditNoteNumber" text
);


--
-- Name: sales_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_orders (
    id text NOT NULL,
    "wcOrderId" integer,
    "wcOrderNumber" text,
    status public."SalesOrderStatus" DEFAULT 'PENDING'::public."SalesOrderStatus" NOT NULL,
    currency text DEFAULT 'GBP'::text NOT NULL,
    "fxRateToGbp" numeric(18,8) DEFAULT 1 NOT NULL,
    "customerName" text,
    "customerEmail" text,
    "billingAddress" jsonb,
    "shippingAddress" jsonb,
    "subtotalForeign" numeric(18,4) NOT NULL,
    "shippingForeign" numeric(18,4) DEFAULT 0 NOT NULL,
    "taxForeign" numeric(18,4) DEFAULT 0 NOT NULL,
    "totalForeign" numeric(18,4) NOT NULL,
    "subtotalGbp" numeric(18,4) NOT NULL,
    "shippingGbp" numeric(18,4) DEFAULT 0 NOT NULL,
    "taxGbp" numeric(18,4) DEFAULT 0 NOT NULL,
    "totalGbp" numeric(18,4) NOT NULL,
    "shipFromWarehouseId" text,
    "shippedAt" timestamp(3) without time zone,
    "trackingNumber" text,
    notes text,
    "internalNotes" text,
    "wcCreatedAt" timestamp(3) without time zone,
    "wcUpdatedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "customerId" text,
    "expectedDelivery" timestamp(3) without time zone,
    "salesRep" text,
    "discountStr" text,
    "discountAmount" numeric(18,4) DEFAULT 0 NOT NULL,
    "shippingService" text,
    "invoiceNumber" text,
    "invoicedAt" timestamp(3) without time zone,
    "paidAt" timestamp(3) without time zone,
    "taxRateName" text,
    "taxRatePercent" numeric(5,4)
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    "userId" text NOT NULL,
    token text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: stock_count_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_count_lines (
    id text NOT NULL,
    "countId" text NOT NULL,
    "productId" text NOT NULL,
    sku text NOT NULL,
    "expectedQty" numeric(12,4) NOT NULL,
    "countedQty" numeric(12,4),
    variance numeric(12,4),
    notes text
);


--
-- Name: stock_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_counts (
    id text NOT NULL,
    reference text NOT NULL,
    "warehouseId" text NOT NULL,
    status public."StockCountStatus" DEFAULT 'DRAFT'::public."StockCountStatus" NOT NULL,
    notes text,
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: stock_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_levels (
    id text NOT NULL,
    "productId" text NOT NULL,
    "warehouseId" text NOT NULL,
    quantity numeric(12,4) DEFAULT 0 NOT NULL,
    "reservedQty" numeric(12,4) DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id text NOT NULL,
    type public."StockMovementType" NOT NULL,
    "productId" text NOT NULL,
    "fromWarehouseId" text,
    "toWarehouseId" text,
    qty numeric(12,4) NOT NULL,
    note text,
    "referenceType" text,
    "referenceId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: stock_transfer_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_transfer_lines (
    id text NOT NULL,
    "transferId" text NOT NULL,
    "productId" text NOT NULL,
    sku text NOT NULL,
    qty numeric(12,4) NOT NULL,
    "qtyReceived" numeric(12,4) DEFAULT 0 NOT NULL,
    "productName" text DEFAULT ''::text NOT NULL
);


--
-- Name: stock_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_transfers (
    id text NOT NULL,
    reference text NOT NULL,
    "fromWarehouseId" text NOT NULL,
    "toWarehouseId" text NOT NULL,
    status public."StockTransferStatus" DEFAULT 'DRAFT'::public."StockTransferStatus" NOT NULL,
    notes text,
    "dispatchedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: supplier_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_products (
    id text NOT NULL,
    "supplierId" text NOT NULL,
    "productId" text NOT NULL,
    "supplierSku" text,
    "lastUnitCost" numeric(18,6) NOT NULL,
    currency text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id text NOT NULL,
    name text NOT NULL,
    "contactName" text,
    email text,
    phone text,
    "addressLine1" text,
    "addressLine2" text,
    city text,
    county text,
    postcode text,
    country text,
    currency text DEFAULT 'GBP'::text NOT NULL,
    "taxRateId" text,
    "vatNumber" text,
    "accountNumber" text,
    "paymentTermsDays" integer,
    notes text,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: tax_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_rates (
    id text NOT NULL,
    name text NOT NULL,
    rate numeric(5,4) NOT NULL,
    type public."TaxType" DEFAULT 'VAT'::public."TaxType" NOT NULL,
    "countryCode" text,
    active boolean DEFAULT true NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "usedFor" text DEFAULT 'BOTH'::text NOT NULL,
    "xeroTaxType" text
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    "passwordHash" text NOT NULL,
    role public."UserRole" DEFAULT 'ADMIN'::public."UserRole" NOT NULL,
    "totpSecret" text,
    "totpEnabled" boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "lastLoginAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "pictureUrl" text
);


--
-- Name: warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouses (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    type public."WarehouseType" DEFAULT 'STANDARD'::public."WarehouseType" NOT NULL,
    "availableForSale" boolean DEFAULT true NOT NULL,
    "syncToWoocommerce" boolean DEFAULT false NOT NULL,
    "addressLine1" text,
    "addressLine2" text,
    city text,
    postcode text,
    country text DEFAULT 'GB'::text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "defaultReturnWarehouse" boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: wc_sync_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wc_sync_logs (
    id text NOT NULL,
    direction public."WcSyncDirection" NOT NULL,
    status public."WcSyncStatus" DEFAULT 'PENDING'::public."WcSyncStatus" NOT NULL,
    "entityType" text NOT NULL,
    "entityId" text,
    "wcId" integer,
    payload jsonb,
    "errorMessage" text,
    "syncedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: xero_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.xero_accounts (
    id text NOT NULL,
    "xeroId" text NOT NULL,
    code text,
    name text NOT NULL,
    type text NOT NULL,
    "taxType" text,
    active boolean DEFAULT true NOT NULL,
    "syncedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: xero_sync_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.xero_sync_logs (
    id text NOT NULL,
    type public."XeroSyncType" NOT NULL,
    status public."XeroSyncStatus" DEFAULT 'PENDING'::public."XeroSyncStatus" NOT NULL,
    "referenceType" text NOT NULL,
    "referenceId" text NOT NULL,
    "xeroTransactionId" text,
    payload jsonb,
    "errorMessage" text,
    "syncedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;
a2418cf9-ba26-4b87-b4a8-5d8c4539a8cf	d1a4e553fa1bbb1f97aabb646e444f5549c899e62ea858a459d332893b928332	2026-04-02 22:07:56.999342+00	20260402220756_init	\N	\N	2026-04-02 22:07:56.708307+00	1
584fb451-b215-4158-82f2-a4841149473b	8988674a6dc661ae2c7a342a6f10fbf6697bfd0d22af96aa730d4393b1fa043f	2026-04-04 00:05:40.851063+00	20260404010000_so_discount_fields	\N	\N	2026-04-04 00:05:40.830508+00	1
9f543142-1ea9-4658-9214-1e2262fc89de	f599b56556181c0694947e1e2a50cc60df9eff315df08aea9753674230a23b32	2026-04-02 23:08:57.446036+00	20260402230857_add_product_image_adjustment_sync	\N	\N	2026-04-02 23:08:57.438316+00	1
fbb656fa-b249-4c0c-a5b6-eb540c095a50	6aa5f99c4e6c90816d5908fecb9030ac30066c4abba006be8897085d762b7031	2026-04-03 16:25:18.287626+00	20260403200000_tax_rate_used_for	\N	\N	2026-04-03 16:25:18.277211+00	1
ccdce874-7214-4351-b67c-38ff562d7886	e3cd904b8dd04354943352af9b972b79f60fb0eda3a4f19e0778b53e1d89e668	2026-04-02 23:19:14.369488+00	20260402231914_add_product_dimensions	\N	\N	2026-04-02 23:19:14.362275+00	1
98dcee38-9f2e-4fa5-a187-b69517c6ef5b	14eb473a1333be1aa6db3a23b472c3837e6a6b9f93d7569bfb0351a8ba139c63	2026-04-02 23:34:07.987472+00	20260402233407_add_non_inventory_type	\N	\N	2026-04-02 23:34:07.981572+00	1
5542d94d-2344-4069-a380-f18774c867cc	7d21a2b9d2746328523a44b2dd21580c87aaa668daee304c95f5bfdeff43aebc	2026-04-02 23:42:43.824265+00	20260402234243_remove_wc_product_ids	\N	\N	2026-04-02 23:42:43.813962+00	1
6d5280f1-5af4-4396-876b-490c00b99dea	1334a7ef21c02dcec982a541bb67aca81088e4380489ad882254f1473d063c8f	2026-04-03 16:48:25.530114+00	20260403210000_purchase_units	\N	\N	2026-04-03 16:48:25.504777+00	1
cb115b7a-0199-477f-9a25-b4ded7334cd9	08797240fb0dbb7f7bf593aa4966ee26055dec2e6f57bee3896ea9716a1aa843	2026-04-02 23:54:27.956562+00	20260402235427_add_po_destination_warehouse	\N	\N	2026-04-02 23:54:27.945299+00	1
b6b305c1-9895-4c1b-bbe6-7c060682c3d1	1fac85de6aff5c3173b55bf7a853b31bafa5700b22a03d6465c4ff428f929281	2026-04-03 11:02:17.23303+00	20260403110217_add_product_options	\N	\N	2026-04-03 11:02:17.220727+00	1
c812151a-18fc-4969-904c-61e307ed7d0c	7cda2254ebfd42a5cf2480a84bbd63d5d2918a7f37dafc6078590d6d6b2641a1	2026-04-03 12:05:46.093661+00	20260403120546_add_sale_price	\N	\N	2026-04-03 12:05:46.087426+00	1
5c0433f5-7e74-4cbd-b239-01c7d01b6aa3	4459a8b1f52663f099676506ba2556a82e9584548585697d921bf5047fb7da26	2026-04-03 16:58:32.187519+00	20260403220000_stock_unit_names	\N	\N	2026-04-03 16:58:32.170502+00	1
0ca3255d-f7d6-4dca-9bc1-20067205f509	fa5aa68568aa38abae588d59454edd79e1aa45e48f21264e9b4170ce3fe6c995	2026-04-03 12:26:04.902396+00	20260403122604_add_adjustment_reasons	\N	\N	2026-04-03 12:26:04.895198+00	1
c2e62a96-775f-49b4-8997-26955e46bc20	0f228e7ec8d5d235a78608f6dfb27b2b97d09124dcd08301eb0dcd534de973dd	2026-04-03 12:57:24.358459+00	20260403125724_add_oversell_allowed	\N	\N	2026-04-03 12:57:24.351765+00	1
dfa56ad7-eb3d-49e9-90f7-d8630f296cef	235296048b989482bb6ba8222173e9fb0fdc154464d82e41f59cb549d5a8594b	2026-04-04 00:12:56.214661+00	20260404020000_so_shipping_service	\N	\N	2026-04-04 00:12:56.200173+00	1
6d210bf2-9ec1-4999-925e-783ed28a1d77	45ae124881a3c2034b75df98eb0ddffe29f9325e99042dcb232ae1a21b9fc76f	2026-04-03 13:00:28.932911+00	20260403130028_oversell_default_true	\N	\N	2026-04-03 13:00:28.926429+00	1
00fbe25e-b875-4b6d-a2fb-7dd9b935e256	4f6ef2a7fbb48fa8022dc7e148a5294879cc2e78908cbe3cdd0aaad702225617	2026-04-03 17:59:25.759755+00	20260403230000_purchase_invoice_lines	\N	\N	2026-04-03 17:59:25.730556+00	1
5df03368-d216-43d4-b2ce-9e431a8db932	c3c893313ced053aa0d328b640f7b8ada669e2bb8cc381dcbfee238e109c1759	2026-04-03 13:09:15.226764+00	20260403130915_add_bom_type_and_product_components	\N	\N	2026-04-03 13:09:15.21001+00	1
06c30ae8-fa7d-45fd-adcb-3334b2a61637	7f5d24c1d5602e8b4863a4ccfebd4f39a3c34355fb493fee6d19576ed3344f48	2026-04-03 14:06:31.10978+00	20260403160000_transfer_received_and_name	\N	\N	2026-04-03 14:06:31.092937+00	1
6194ac75-3a71-4624-b36f-0e1112a28f0f	4736bb8110f46332145a7bca7b7cb12884a460aff6e5199ddac788ae884ae40b	2026-04-03 18:24:03.537526+00	20260403240000_freight_cost_lines	\N	\N	2026-04-03 18:24:03.516643+00	1
e7693fc1-bac5-47f7-bb37-ae2209d8e13c	7c604bd75a2d1669c3d636c9a1a1dc68a904c01d5026270b28b7c173e4cbfe67	2026-04-05 21:54:38.333052+00	20260405215438_add_document_templates	\N	\N	2026-04-05 21:54:38.317758+00	1
768f742c-1f1f-44d6-9c89-7a7e0cbaff8f	37de2e3c40948fc370ad0058d006df42c8f2599c0b5cd99b9c891d113546c8ba	2026-04-03 22:56:13.453952+00	20260403250000_customers	\N	\N	2026-04-03 22:56:13.430871+00	1
76dfb7f3-660f-47cd-9357-510551e7430d	4e3ab913653f6a5158f860eda91237254195e6ab6979b4296b3322329238108d	2026-04-05 12:34:08.389061+00	20260404030000_so_invoice_paid	\N	\N	2026-04-05 12:34:08.375908+00	1
94d5bf29-e7f4-4268-a6d8-46cf55d38654	bdcd7194c815953913a65d005e0ec296673a817a8cbd4f17a4bf071ebdddc57c	2026-04-03 23:08:37.774223+00	20260403260000_customer_name_split	\N	\N	2026-04-03 23:08:37.751698+00	1
ae8ce380-0cae-4e6f-bd71-48cc12216f75	f5d95a495071091d74d69719db8efc2f4d67b7d2bcdaf7042e1bb3cfc88026e3	2026-04-03 23:27:04.120351+00	20260403270000_so_delivery_salesrep	\N	\N	2026-04-03 23:27:04.101061+00	1
f27318ef-3358-4a7d-9df5-c06173932706	5bb5c23e2ec3f10f793f1a709c63c6fc2532d68bfacbe6741cf72d8acc0bb9b9	2026-04-05 17:36:55.295034+00	20260405173655_add_user_picture	\N	\N	2026-04-05 17:36:55.281032+00	1
79de2428-ea64-482d-bbf1-5fabb12fcdcd	1d7cc92d2f681b1b840c522c756037e398745ecbf87e888e247193a5698b3dda	2026-04-05 13:02:01.513008+00	20260404040000_tax_rate_name_on_orders	\N	\N	2026-04-05 13:02:01.496391+00	1
bb9a298c-74b6-4974-a401-ea54a496236c	20f5a694fbc1ae4c89c8f3c57949aae43e0c8b22be05ba39a4d8ea7f32269bb2	2026-04-05 13:17:49.458411+00	20260404050000_credit_note_number	\N	\N	2026-04-05 13:17:49.447667+00	1
c775786e-6666-4b01-bc83-2ae1b65c9e18	76122bed2bc74a118e246432c82d0f3ce82fecdd6c3a66e6c1984681f5e7766f	2026-04-05 21:12:44.286894+00	20260405211244_add_passkeys	\N	\N	2026-04-05 21:12:44.269084+00	1
5f7b69d7-9e73-4ba0-91e2-9889ffcddb8f	949062c80997f3682f46727a8f1eaa4e04a396b4c9732399df6125c4b508f236	2026-04-05 13:23:14.678772+00	20260404060000_payments	\N	\N	2026-04-05 13:23:14.647197+00	1
7c8de3f9-3942-4d4a-928b-3e6b85e2ba93	5f090de4b51e254dbf26ee6c85739e78b003251106c41461e8342644fbcb3503	2026-04-05 21:27:18.644471+00	20260405212718_activity_log_level_tag	\N	\N	2026-04-05 21:27:18.619541+00	1
feb020e5-fe34-4181-ab8b-2854026a1ecb	5ec30d81386e497fdee69fc3f16c94c7c8e5f4bdc583642e54de01621a0ea5be	2026-04-05 22:08:44.928413+00	20260405220844_add_document_logo	\N	\N	2026-04-05 22:08:44.922157+00	1
285a4b83-59e1-4131-b634-c394aa1ac3d8	8e62ff8900794662a20083126396a0cea96c3bfbcf94501626374d1e1bc1ac21	2026-04-05 23:19:17.401981+00	20260405231917_manufacturing_order_type	\N	\N	2026-04-05 23:19:17.385598+00	1
182c4002-b054-4db5-967c-ad4c165d8800	0b8a7212c51377c9db856ccf3999cc1f87f1b1f3361a2cb7474f8a42f88ad17f	2026-04-05 22:31:04.000511+00	20260405223103_add_custom_footer	\N	\N	2026-04-05 22:31:03.990535+00	1
\.


--
-- Data for Name: activity_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.activity_logs (id, "userId", "entityType", "entityId", action, description, metadata, "createdAt", level, tag) FROM stdin;
cmnmabl03000097ig994firx5	cmni10iea0008d0igxzpikwbu	PRODUCT	cmni31u9000002uiglrntz0w3	updated	Updated product 123456 — Test AB	{"sku": "123456", "name": "Test AB", "type": "SIMPLE"}	2026-04-05 21:39:56.307	INFO	inventory
cmnmbexzu0000snig8oj2opt7	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated company details	\N	2026-04-05 22:10:32.73	INFO	settings
cmnmbg1k00001snig7mhdngoh	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated company details	\N	2026-04-05 22:11:24	INFO	settings
cmnmbgv1c0002snig0s0cjbdv	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated branding colours	\N	2026-04-05 22:12:02.208	INFO	settings
cmnmbhfhg0003snigpjg4fn1s	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated branding colours	\N	2026-04-05 22:12:28.708	INFO	settings
cmnmbhssc0005sniglwfkmymm	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated sales order document template	\N	2026-04-05 22:12:45.948	INFO	settings
cmnmbiv8h0006snig7f18vfro	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated company details	\N	2026-04-05 22:13:35.777	INFO	settings
cmnmbjb9m00002higkyh9jsyo	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated company details	\N	2026-04-05 22:13:56.555	INFO	settings
cmnmbju3e00012higzeeswtq9	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated company details	\N	2026-04-05 22:14:20.954	INFO	settings
cmnmbpsn600008zig57io7xad	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated company details	\N	2026-04-05 22:18:59.01	INFO	settings
cmnmbx27m0000dvigp8oo9a9q	cmni10iea0008d0igxzpikwbu	SETTING	\N	updated	Updated document numbering formats	\N	2026-04-05 22:24:38.002	INFO	settings
cmnmczlmy00059migh0zdnxwh	cmni10iea0008d0igxzpikwbu	SYNC	\N	fx_rates_fetched	Fetched FX rates for 5 currencies	\N	2026-04-05 22:54:36.106	INFO	sync
cmnme17g200014rigppj95wye	cmni10iea0008d0igxzpikwbu	PRODUCT	\N	created	Created product 567890 — BOM product	{"sku": "567890", "name": "BOM product", "type": "BOM"}	2026-04-05 23:23:50.642	INFO	inventory
cmnme209g00034rig4w9eyb2r	cmni10iea0008d0igxzpikwbu	PRODUCT	cmnme17fa00004rigifne82co	updated	Updated BOM/kit components for product cmnme17fa00004rigifne82co	{"componentCount": 1}	2026-04-05 23:24:27.988	INFO	manufacturing
cmnme3cex00054rigosz2fbnb	cmni10iea0008d0igxzpikwbu	PRODUCT	cmnme17fa00004rigifne82co	updated	Updated BOM/kit components for product cmnme17fa00004rigifne82co	{"componentCount": 1}	2026-04-05 23:25:30.393	INFO	manufacturing
cmnme57ky00094rigd18kitqi	cmni10iea0008d0igxzpikwbu	PRODUCTION_ORDER	cmnme57k200084rig1t8wryex	created	Created assembly order MO-20260405-RUP8 for 567890 — BOM product (5 units)	{"qty": 5, "sku": "567890", "orderType": "ASSEMBLY", "reference": "MO-20260405-RUP8"}	2026-04-05 23:26:57.442	INFO	manufacturing
cmnmefb0k0000h8ighdeefxnl	cmni10iea0008d0igxzpikwbu	PRODUCTION_ORDER	cmnme57k200084rig1t8wryex	status_changed	Updated MO-20260405-RUP8 status to IN_PROGRESS	\N	2026-04-05 23:34:48.452	INFO	manufacturing
cmnmefdtg0001h8igpmt1z4ce	cmni10iea0008d0igxzpikwbu	PRODUCTION_ORDER	cmnme57k200084rig1t8wryex	status_changed	Updated MO-20260405-RUP8 status to COMPLETED	\N	2026-04-05 23:34:52.084	INFO	manufacturing
cmnmet7fv0001xcigl6n3ww7y	cmni10iea0008d0igxzpikwbu	PRODUCTION_ORDER	cmnmet7dc0000xcig9jgl5dac	created	Created assembly order MO-20260405-IGW1 for 567890 — BOM product (5 units)	{"qty": 5, "sku": "567890", "orderType": "ASSEMBLY", "reference": "MO-20260405-IGW1"}	2026-04-05 23:45:37.003	INFO	manufacturing
cmnmetby20003xcign7abg4s6	cmni10iea0008d0igxzpikwbu	STOCK_ADJUSTMENT	cmni31u9000002uiglrntz0w3	reserved	MO-20260405-IGW1: reserved 25 units of component for 567890 assembly	{"qty": 25, "moReference": "MO-20260405-IGW1", "warehouseId": "cmni10hv50000d0ig530dr2r0"}	2026-04-05 23:45:42.842	INFO	stock
cmnmetby50004xcigw8805rse	cmni10iea0008d0igxzpikwbu	PRODUCTION_ORDER	cmnmet7dc0000xcig9jgl5dac	status_changed	Updated MO-20260405-IGW1 status to IN_PROGRESS	\N	2026-04-05 23:45:42.845	INFO	manufacturing
\.


--
-- Data for Name: adjustment_reasons; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.adjustment_reasons (id, name, "xeroAccountCode", "sortOrder", active, "createdAt", "updatedAt") FROM stdin;
cmnivt6yt00007zigv18oere8	Item Missing	\N	0	t	2026-04-03 12:30:25.158	2026-04-03 12:30:25.158
cmnivz8dw00027zigg6yipuxs	Item Found	\N	0	t	2026-04-03 12:35:06.932	2026-04-03 12:36:20.22
cmniw4pda00037zigazpgbdu4	Item Damaged	\N	0	t	2026-04-03 12:39:22.222	2026-04-03 12:39:22.222
cmniwghjr00057zig7kgx51nc	Item Written Off	\N	0	t	2026-04-03 12:48:31.959	2026-04-03 12:48:31.959
\.


--
-- Data for Name: bom_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bom_items (id, "bomId", "parentProductId", "componentProductId", qty, notes, "sortOrder") FROM stdin;
cmnme57jl00074rigqtg8emos	cmnme57jj00064rig72f0di2x	cmnme17fa00004rigifne82co	cmni31u9000002uiglrntz0w3	5.0000	\N	0
\.


--
-- Data for Name: boms; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.boms (id, name, description, active, "createdAt", "updatedAt") FROM stdin;
cmnme57jj00064rig72f0di2x	567890 BOM	\N	t	2026-04-05 23:26:57.391	2026-04-05 23:26:57.391
\.


--
-- Data for Name: cogs_entries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cogs_entries (id, "costLayerId", "movementId", qty, "unitCostGbp", "totalCostGbp", "createdAt") FROM stdin;
\.


--
-- Data for Name: cost_layers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cost_layers (id, "productId", "warehouseId", "receivedQty", "remainingQty", "unitCostGbp", "receivedAt", "poLineId", "isOpeningStock") FROM stdin;
cmnj6zu8z00034wigj3jqe296	cmni31u9000002uiglrntz0w3	cmni10hv50000d0ig530dr2r0	60.0000	60.0000	0.436262	2026-04-03 17:43:31.043	cmnj6dg440001mmigma8k5vop	f
\.


--
-- Data for Name: currencies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.currencies (code, name, symbol, "usedFor", active, "createdAt") FROM stdin;
GBP	British Pound Sterling	£	BOTH	t	2026-04-02 22:08:17.836
EUR	Euro	€	BOTH	t	2026-04-02 22:08:17.847
USD	US Dollar	$	BOTH	t	2026-04-02 22:08:17.851
NOK	Norwegian Krone	kr	BOTH	t	2026-04-02 22:08:17.863
SEK	Swedish Krona	kr	PURCHASE	t	2026-04-02 22:08:17.877
CAD	Canadian Dollar	C$	PURCHASE	t	2026-04-02 22:08:17.884
\.


--
-- Data for Name: customers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customers (id, email, phone, company, "billingAddress", "shippingAddress", notes, "wcCustomerId", active, "createdAt", "updatedAt", "firstName", "lastName", "taxNumber") FROM stdin;
cmnjke8az0000p3igb3pmbb7r	info@onetwo3d.co.uk	07960214165	One Two Enterprises Ltd	{"city": "Cambridge", "line1": "1 Blue Lion Close, Fen Ditton", "line2": "Fen Ditton", "county": "Cambridgeshire", "country": "United Kingdom", "postcode": "CB58ZB"}	{"city": "Cambridge", "line1": "1 Blue Lion Close, Fen Ditton", "line2": "Fen Ditton", "county": "Cambridgeshire", "country": "United Kingdom", "postcode": "CB58ZB"}	\N	\N	t	2026-04-03 23:58:37.451	2026-04-05 13:14:41.852	Jan	Schwarz	GB123456789
\.


--
-- Data for Name: document_templates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.document_templates (id, type, "headerNote", "footerNote", "termsText", "showLogo", "showVat", "showPaymentTerms", "paymentTermsText", "updatedAt", "customFooter") FROM stdin;
cmnmbhsq10004snige8oe1vyq	sales_order	\N	\N	\N	t	t	f	\N	2026-04-05 22:12:45.865	\N
\.


--
-- Data for Name: freight_cost_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.freight_cost_lines (id, "poId", description, "amountForeign", "amountGbp", vatable, "distributionMethod", "sortOrder") FROM stdin;
cmnjhf4z200041yig80wyonf7	cmnjhf4z000031yigihw8slit	Shipping	15.0000	13.0879	f	BY_WEIGHT	0
\.


--
-- Data for Name: fx_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fx_rates (id, "fromCurrency", "toCurrency", rate, "fetchedAt") FROM stdin;
cmnj3dxku0000ctigtlwcafci	GBP	EUR	1.14610000	2026-04-03 16:02:30.078
cmnj3dxkz0001ctigu2b0buqb	GBP	USD	1.32090000	2026-04-03 16:02:30.084
cmnj3dxl50002ctigkeuhz88a	GBP	NOK	12.86890000	2026-04-03 16:02:30.089
cmnj3dxl90003ctigdkqhbclm	GBP	SEK	12.54740000	2026-04-03 16:02:30.093
cmnj3dxlg0004ctig1lg3uduu	GBP	CAD	1.83720000	2026-04-03 16:02:30.1
cmnmczlk200009mig9xqq2mxs	GBP	EUR	1.14610000	2026-04-05 22:54:36.003
cmnmczlkl00019mig0de059x0	GBP	USD	1.32090000	2026-04-05 22:54:36.021
cmnmczlkp00029migfjo9bif0	GBP	NOK	12.86890000	2026-04-05 22:54:36.025
cmnmczlkw00039migyegza351	GBP	SEK	12.54740000	2026-04-05 22:54:36.032
cmnmczll400049migbuvukbdc	GBP	CAD	1.83720000	2026-04-05 22:54:36.04
\.


--
-- Data for Name: kit_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.kit_items (id, "kitId", "parentProductId", "componentProductId", qty, "sortOrder") FROM stdin;
\.


--
-- Data for Name: kits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.kits (id, name, description, active, "createdAt", "updatedAt") FROM stdin;
\.


--
-- Data for Name: landed_cost_links; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.landed_cost_links (id, "primaryPoId", "freightPoId", method, allocated, "createdAt") FROM stdin;
cmnjhf4z200051yigfv518ved	cmnjhdv2700001yig2ob7q4dg	cmnjhf4z000031yigihw8slit	BY_WEIGHT	f	2026-04-03 22:35:20.94
\.


--
-- Data for Name: organisations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.organisations (id, name, "legalName", "vatNumber", "companyNumber", "addressLine1", "addressLine2", city, county, postcode, country, phone, email, website, "logoUrl", "baseCurrency", "financialYearStartMonth", "financialYearStartDay", "createdAt", "updatedAt", "documentLogoUrl") FROM stdin;
default	onetwo3D	One Two Enterprises Ltd	GB123456789	456789	1 Blue Lion Close	Fen Ditton	Cambridge	Cambridgeshire	CB58ZB	United Kingdom	+4433305515	sales@onetwo3d.co.uk	www.onetwo3d.co.uk	/api/uploads/branding/logo.svg?t=1775427533329	GBP	5	1	2026-04-02 22:08:17.748	2026-04-05 22:18:58.981	/api/uploads/branding/document-logo.svg?t=1775427511487
\.


--
-- Data for Name: passkeys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.passkeys (id, "userId", "credentialId", "credentialPublicKey", counter, transports, name, "createdAt") FROM stdin;
cmnm9l4xu0000lkiglr63al7r	cmni10iea0008d0igxzpikwbu	dgCAca9lR6-50S1Mg5xHsQ	\\xa501020326200121582078517b3888a1d61c2f4aafb667ef48114cddc649e8b046e287496616953f0fb822582073c4caf45806a788e1fcbedd3edea41bf38a3d624d9722552b571c011a8f1b35	0	{internal,hybrid}	Bitwarden	2026-04-05 21:19:22.434
\.


--
-- Data for Name: payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payments (id, "orderId", "refundId", amount, currency, method, reference, notes, "paidAt", "createdAt") FROM stdin;
\.


--
-- Data for Name: product_components; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.product_components (id, "productId", "componentId", qty, "sortOrder") FROM stdin;
cmnixrpex000527igjdgox7k3	cmnixpqxe000027ig1khzwdx9	cmniubxhi0004vqigtc3cwv77	2.0000	0
cmnixrpex000627ig2n4h9p33	cmnixpqxe000027ig1khzwdx9	cmni31u9000002uiglrntz0w3	5.0000	1
cmnme3cdz00044rigk295a9v8	cmnme17fa00004rigifne82co	cmni31u9000002uiglrntz0w3	5.0000	0
\.


--
-- Data for Name: product_options; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.product_options (id, "productId", name, "values", "sortOrder") FROM stdin;
cmniufnfa000avqig3sxhqtza	cmnitwc830000n5igg9og7dik	Colour	black,blue,green	0
\.


--
-- Data for Name: production_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.production_orders (id, reference, "bomId", "outputProductId", "warehouseId", "qtyPlanned", "qtyProduced", status, "scheduledAt", "startedAt", "completedAt", notes, "createdAt", "updatedAt", "manufacturerId", "orderType") FROM stdin;
cmnme57k200084rig1t8wryex	MO-20260405-RUP8	cmnme57jj00064rig72f0di2x	cmnme17fa00004rigifne82co	cmni10hv50000d0ig530dr2r0	5.0000	0.0000	COMPLETED	2026-04-08 00:00:00	2026-04-05 23:34:48.41	2026-04-05 23:34:52.057	\N	2026-04-05 23:26:57.41	2026-04-05 23:34:52.06	\N	ASSEMBLY
cmnmet7dc0000xcig9jgl5dac	MO-20260405-IGW1	cmnme57jj00064rig72f0di2x	cmnme17fa00004rigifne82co	cmni10hv50000d0ig530dr2r0	5.0000	0.0000	IN_PROGRESS	2026-04-15 00:00:00	2026-04-05 23:45:42.756	\N	\N	2026-04-05 23:45:36.913	2026-04-05 23:45:42.768	\N	ASSEMBLY
\.


--
-- Data for Name: products; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.products (id, sku, name, description, type, "parentId", barcode, weight, active, "salesPriceGbp", "salesPriceTaxInclusive", "createdAt", "updatedAt", "imageUrl", "depthCm", "heightCm", "widthCm", "salePriceGbp", "oversellAllowed", "stockUnit") FROM stdin;
cmniubxhi0004vqigtc3cwv77	456789-BLACK-5	variable product - black 5	\N	VARIANT	cmnitwc830000n5igg9og7dik	\N	4.3500	t	\N	f	2026-04-03 11:49:00.102	2026-04-03 11:49:00.102	\N	6.00	5.00	4.00	\N	f	pcs
cmniubxho0005vqig427mpe3p	456789-BLACK-10	variable product - black 10	\N	VARIANT	cmnitwc830000n5igg9og7dik	\N	4.3500	t	\N	f	2026-04-03 11:49:00.108	2026-04-03 11:49:00.108	\N	6.00	5.00	4.00	\N	f	pcs
cmniubxht0006vqigsa141183	456789-BLUE-5	variable product - blue 5	\N	VARIANT	cmnitwc830000n5igg9og7dik	\N	4.3500	t	\N	f	2026-04-03 11:49:00.113	2026-04-03 11:49:00.113	\N	6.00	5.00	4.00	\N	f	pcs
cmniubxhw0007vqig1ndfaf4s	456789-BLUE-10	variable product - blue 10	\N	VARIANT	cmnitwc830000n5igg9og7dik	\N	4.3500	t	\N	f	2026-04-03 11:49:00.116	2026-04-03 11:49:00.116	\N	6.00	5.00	4.00	\N	f	pcs
cmniubxi30008vqigshe21gns	456789-GREEN-5	variable product - green 5	\N	VARIANT	cmnitwc830000n5igg9og7dik	\N	4.3500	t	\N	f	2026-04-03 11:49:00.123	2026-04-03 11:49:00.123	\N	6.00	5.00	4.00	\N	f	pcs
cmniubxi60009vqigev90wv5f	456789-GREEN-10	variable product - green 10	\N	VARIANT	cmnitwc830000n5igg9og7dik	\N	4.3500	t	\N	f	2026-04-03 11:49:00.126	2026-04-03 11:49:00.126	\N	6.00	5.00	4.00	\N	f	pcs
cmnitwc830000n5igg9og7dik	456789	variable product	Variable product 	VARIABLE	\N	\N	4.3500	t	34.0000	f	2026-04-03 11:36:52.707	2026-04-03 11:52:00.844	\N	6.00	5.00	4.00	\N	f	pcs
cmnixpqxe000027ig1khzwdx9	7643456	Bundle Test	\N	KIT	\N	\N	\N	t	\N	f	2026-04-03 13:23:43.634	2026-04-03 13:23:43.634	\N	\N	\N	\N	\N	t	pcs
cmni31u9000002uiglrntz0w3	123456	Test AB	Test Product	SIMPLE	\N	567890	1.2000	t	23.9900	f	2026-04-02 23:05:19.716	2026-04-05 21:39:56.276	https://www.onetwo3d.co.uk/wp-content/uploads/2025/06/SC-ToolDock-02-300x300.png	\N	\N	\N	\N	t	pcs
cmnme17fa00004rigifne82co	567890	BOM product	manufactured product	BOM	\N	1234567890123	\N	t	67.0000	f	2026-04-05 23:23:50.614	2026-04-05 23:23:50.614	\N	\N	\N	\N	\N	t	pcs
\.


--
-- Data for Name: purchase_invoice_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_invoice_lines (id, "invoiceId", "poLineId", "qtyBilled", "unitCostForeign", "totalForeign", "totalGbp") FROM stdin;
cmnj7s9bq0001qfigekva0cq1	cmnj7s9bo0000qfigvjokieup	cmnj6dg440001mmigma8k5vop	60.0000	0.500000	30.0000	26.1757
\.


--
-- Data for Name: purchase_invoices; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_invoices (id, "poId", "invoiceNumber", "invoiceDate", "dueDate", "totalForeign", "totalGbp", "fxRateToGbp", notes, "xeroInvoiceId", "createdAt", "updatedAt", "subtotalForeign", "subtotalGbp", "taxForeign", "taxGbp", "supplierInvoiceUrl") FROM stdin;
cmnj7s9bo0000qfigvjokieup	cmnj6dg420000mmigj811bsm6	ab123	2026-04-03 00:00:00	2026-04-03 00:00:00	30.0000	26.1757	1.14610000	\N	\N	2026-04-03 18:05:36.948	2026-04-03 18:05:36.948	30.0000	26.1757	0.0000	0.0000	/uploads/invoices/1775239534139-2006.03.06.pdf
\.


--
-- Data for Name: purchase_order_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_order_lines (id, "poId", "productId", description, qty, "unitCostForeign", "unitCostGbp", "taxRateId", "taxForeign", "taxGbp", "totalForeign", "totalGbp", "landedUnitCostGbp", "qtyReceived", "qtyReturned", "sortOrder", "purchaseUnitId", "purchaseUnitQty") FROM stdin;
cmnj6dg440001mmigma8k5vop	cmnj6dg420000mmigj811bsm6	cmni31u9000002uiglrntz0w3	\N	60.0000	0.500000	0.436262	\N	0.0000	0.0000	30.0000	26.1757	0.000000	60.0000	5.0000	0	cmnj58phs0000soigzc534kfy	5.0000
cmnjhdv2800011yigofp2w929	cmnjhdv2700001yig2ob7q4dg	cmni31u9000002uiglrntz0w3	\N	5.0000	0.500000	0.436262	\N	0.0000	0.0000	2.5000	2.1813	0.000000	0.0000	0.0000	0	\N	\N
\.


--
-- Data for Name: purchase_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_orders (id, reference, type, "supplierId", status, currency, "fxRateToGbp", "subtotalForeign", "subtotalGbp", "taxForeign", "taxGbp", "totalForeign", "totalGbp", "directFreightForeign", "directFreightGbp", "landedCostMethod", notes, "internalNotes", "supplierRef", "expectedDelivery", "receivedAt", "invoicedAt", "rfqSentAt", "poSentAt", "createdAt", "updatedAt", "destinationWarehouseId", "taxRateName", "taxRatePercent") FROM stdin;
cmnj6dg420000mmigj811bsm6	PO-20260403-6OYN	GOODS	cmnj5xh0x0000a1ig4x6426lp	RECEIVED	EUR	1.14610000	30.0000	26.1757	0.0000	0.0000	30.0000	26.1757	0.0000	0.0000	BY_VALUE	\N	\N	1234	2026-04-27 00:00:00	2026-04-03 17:43:31.06	2026-04-03 18:05:36.961	\N	2026-04-03 17:42:42.752	2026-04-03 17:26:06.29	2026-04-03 18:05:36.967	cmni10hv50000d0ig530dr2r0	\N	\N
cmnjhdv2700001yig2ob7q4dg	PO-20260403-7HF3	GOODS	cmnj5xh0x0000a1ig4x6426lp	PO_SENT	EUR	1.14610000	2.5000	2.1813	0.0000	0.0000	2.5000	2.1813	0.0000	0.0000	BY_VALUE	\N	\N	456	2026-04-21 00:00:00	\N	\N	\N	2026-04-03 22:34:27.29	2026-04-03 22:34:21.439	2026-04-03 22:34:27.291	cmni10hv50000d0ig530dr2r0	\N	\N
cmnjhf4z000031yigihw8slit	PO-20260403-BES1	FREIGHT	cmnj5xh0x0000a1ig4x6426lp	PO_SENT	EUR	1.14610000	15.0000	13.0879	0.0000	0.0000	15.0000	13.0879	15.0000	13.0879	BY_VALUE	\N	\N	678	\N	\N	\N	\N	2026-04-03 22:35:35.025	2026-04-03 22:35:20.94	2026-04-03 22:35:35.025	\N	\N	\N
\.


--
-- Data for Name: purchase_receipt_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_receipt_lines (id, "receiptId", "poLineId", "qtyReceived", "warehouseId") FROM stdin;
cmnj6zu8e00014wigu6lyykvw	cmnj6zu8d00004wig6sgbgfxv	cmnj6dg440001mmigma8k5vop	60.0000	cmni10hv50000d0ig530dr2r0
\.


--
-- Data for Name: purchase_receipts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_receipts (id, "poId", reference, "receivedAt", notes, "createdAt") FROM stdin;
cmnj6zu8d00004wig6sgbgfxv	cmnj6dg420000mmigj811bsm6	RCP-PO-20260403-6OYN-MNJ6ZU81	2026-04-03 17:43:31.021	\N	2026-04-03 17:43:31.021
\.


--
-- Data for Name: purchase_return_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_return_lines (id, "returnId", "poLineId", "qtyReturned", "warehouseId") FROM stdin;
cmnj831k300010oigdqafqjj1	cmnj831k200000oignkyuh8o0	cmnj6dg440001mmigma8k5vop	5.0000	cmni10hv50000d0ig530dr2r0
\.


--
-- Data for Name: purchase_returns; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_returns (id, "poId", reference, "returnedAt", reason, notes, "createdAt") FROM stdin;
cmnj831k200000oignkyuh8o0	cmnj6dg420000mmigj811bsm6	RTN-PO-20260403-6OYN-MNJ831JQ	2026-04-03 18:14:00.098	damaged	damaged	2026-04-03 18:14:00.098
\.


--
-- Data for Name: purchase_units; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchase_units (id, name, abbreviation, "conversionFactor", active, "createdAt", "updatedAt", "stockUnitName") FROM stdin;
cmnj58phs0000soigzc534kfy	Dozen	dz	12.0000	t	2026-04-03 16:54:25.552	2026-04-03 16:54:25.552	pcs
cmnj5sir1000058igiswzaith	Millilitre	ml	0.0010	t	2026-04-03 17:09:49.933	2026-04-03 17:09:49.933	l
\.


--
-- Data for Name: sales_order_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_order_lines (id, "orderId", "productId", "wcLineItemId", description, sku, qty, "unitPriceForeign", "unitPriceGbp", "taxRateId", "taxForeign", "taxGbp", "totalForeign", "totalGbp", "cogsGbp", "discountStr", "discountAmount") FROM stdin;
cmnjkj0es00010tig0mxno2ng	cmnjkj0el00000tigdc346ses	cmni31u9000002uiglrntz0w3	\N	Test A	123456	2.0000	18.992083	18.992083	\N	7.5968	7.5968	37.9842	37.9842	\N	\N	0.0000
\.


--
-- Data for Name: sales_order_refund_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_order_refund_lines (id, "refundId", "productId", description, qty, "unitPriceGbp", "totalGbp") FROM stdin;
\.


--
-- Data for Name: sales_order_refunds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_order_refunds (id, "orderId", "wcRefundId", "returnWarehouseId", reason, "totalForeign", "totalGbp", "refundedAt", "createdAt", "creditNoteNumber") FROM stdin;
\.


--
-- Data for Name: sales_orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sales_orders (id, "wcOrderId", "wcOrderNumber", status, currency, "fxRateToGbp", "customerName", "customerEmail", "billingAddress", "shippingAddress", "subtotalForeign", "shippingForeign", "taxForeign", "totalForeign", "subtotalGbp", "shippingGbp", "taxGbp", "totalGbp", "shipFromWarehouseId", "shippedAt", "trackingNumber", notes, "internalNotes", "wcCreatedAt", "wcUpdatedAt", "createdAt", "updatedAt", "customerId", "expectedDelivery", "salesRep", "discountStr", "discountAmount", "shippingService", "invoiceNumber", "invoicedAt", "paidAt", "taxRateName", "taxRatePercent") FROM stdin;
cmnjkj0el00000tigdc346ses	\N	SO-20260404-QWZ1	COMPLETED	GBP	1.00000000	Jan Schwarz	\N	\N	\N	37.9842	4.0000	8.2635	50.2477	37.9842	4.0000	8.2635	50.2477	cmni10hvj0001d0igp9tshlgc	2026-04-04 00:04:34.867	12345	\N	\N	\N	\N	2026-04-04 00:02:20.493	2026-04-05 13:09:13.139	cmnjke8az0000p3igb3pmbb7r	2026-04-10 00:00:00	Admin	\N	0.0000	\N	INV-2026-00001	2026-04-05 13:09:13.129	\N	\N	\N
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (id, "userId", token, "expiresAt", "createdAt") FROM stdin;
\.


--
-- Data for Name: settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.settings (key, value, "updatedAt") FROM stdin;
financial_year_start	05-01	2026-04-05 17:27:55.222
brand_primary_color	#ffffff	2026-04-05 22:12:28.661
brand_accent_color	#f90606	2026-04-05 22:12:28.668
numbering_so_prefix	SO-	2026-04-05 22:24:37.816
numbering_so_padding	5	2026-04-05 22:24:37.825
numbering_po_prefix	PO-	2026-04-05 22:24:37.827
numbering_po_padding	5	2026-04-05 22:24:37.831
numbering_inv_prefix	INV-	2026-04-05 22:24:37.832
numbering_inv_padding	5	2026-04-05 22:24:37.837
numbering_cn_prefix	CN-	2026-04-05 22:24:37.838
numbering_cn_padding	5	2026-04-05 22:24:37.838
\.


--
-- Data for Name: stock_count_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_count_lines (id, "countId", "productId", sku, "expectedQty", "countedQty", variance, notes) FROM stdin;
\.


--
-- Data for Name: stock_counts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_counts (id, reference, "warehouseId", status, notes, "startedAt", "completedAt", "createdAt", "updatedAt") FROM stdin;
\.


--
-- Data for Name: stock_levels; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_levels (id, "productId", "warehouseId", quantity, "reservedQty", "updatedAt") FROM stdin;
cmnivcoc40001tkigcazugzx4	cmniubxho0005vqig427mpe3p	cmni10hvj0001d0igp9tshlgc	5.0000	0.0000	2026-04-03 12:17:34.516
cmnixqyzq000427igb18sg3ve	cmniubxhi0004vqigtc3cwv77	cmni10hvj0001d0igp9tshlgc	15.0000	0.0000	2026-04-03 13:24:40.742
cmni3dldf0001e8igz1u0wmus	cmni31u9000002uiglrntz0w3	cmni10hvj0001d0igp9tshlgc	0.0000	0.0000	2026-04-04 00:04:34.889
cmnj167pc0001x1igj5ghzhzh	cmni31u9000002uiglrntz0w3	cmni10hv50000d0ig530dr2r0	51.0000	25.0000	2026-04-05 23:45:42.76
\.


--
-- Data for Name: stock_movements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_movements (id, type, "productId", "fromWarehouseId", "toWarehouseId", qty, note, "referenceType", "referenceId", "createdAt") FROM stdin;
cmni3dlcy0000e8ig19eqd4cm	ADJUSTMENT	cmni31u9000002uiglrntz0w3	\N	cmni10hvj0001d0igp9tshlgc	5.0000	inital inventory	\N	\N	2026-04-02 23:14:28.066
cmnivcobu0000tkigs2eymxek	ADJUSTMENT	cmniubxho0005vqig427mpe3p	\N	cmni10hvj0001d0igp9tshlgc	5.0000	inital stock	\N	\N	2026-04-03 12:17:34.506
cmnixqyzn000327igun17xgql	ADJUSTMENT	cmniubxhi0004vqigtc3cwv77	\N	cmni10hvj0001d0igp9tshlgc	15.0000	Item Found	\N	\N	2026-04-03 13:24:40.739
cmnj0qb4o0002hrigxhv8tc1d	TRANSFER_OUT	cmni31u9000002uiglrntz0w3	cmni10hvj0001d0igp9tshlgc	\N	3.0000	Transfer TRF-20260403-B2KO dispatched	StockTransfer	cmnj0q0ko0000hrigrf3zea3l	2026-04-03 14:48:08.664
cmnj167p00000x1igvkt2z986	TRANSFER_IN	cmni31u9000002uiglrntz0w3	\N	cmni10hv50000d0ig530dr2r0	3.0000	Transfer TRF-20260403-B2KO received	StockTransfer	cmnj0q0ko0000hrigrf3zea3l	2026-04-03 15:00:30.708
cmnj1bj29000092igfn30ecbs	TRANSFER_OUT	cmni31u9000002uiglrntz0w3	cmni10hv50000d0ig530dr2r0	\N	3.0000	Transfer TRF-20260403-JN47 dispatched	StockTransfer	cmnj177d80002x1ign5ztegxu	2026-04-03 15:04:38.721
cmnj6zu8u00024wiglnd55tgj	PURCHASE_RECEIPT	cmni31u9000002uiglrntz0w3	\N	cmni10hv50000d0ig530dr2r0	60.0000	Received against PO-20260403-6OYN	PurchaseOrder	cmnj6dg420000mmigj811bsm6	2026-04-03 17:43:31.038
cmnj831kk00020oigy6rklzri	ADJUSTMENT	cmni31u9000002uiglrntz0w3	cmni10hv50000d0ig530dr2r0	\N	5.0000	Return to supplier against PO-20260403-6OYN — damaged	PurchaseReturn	cmnj6dg420000mmigj811bsm6	2026-04-03 18:14:00.116
cmnj88obp000056igazgrui8a	ADJUSTMENT	cmni31u9000002uiglrntz0w3	cmni10hv50000d0ig530dr2r0	\N	4.0000	Item Damaged	\N	\N	2026-04-03 18:18:22.885
cmnjklw3o00030tigbpaxb9st	SALE_DISPATCH	cmni31u9000002uiglrntz0w3	cmni10hvj0001d0igp9tshlgc	\N	2.0000	Dispatched for order	SalesOrder	cmnjkj0el00000tigdc346ses	2026-04-04 00:04:34.884
\.


--
-- Data for Name: stock_transfer_lines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_transfer_lines (id, "transferId", "productId", sku, qty, "qtyReceived", "productName") FROM stdin;
cmnj0q0ks0001hrig1w4zxdq6	cmnj0q0ko0000hrigrf3zea3l	cmni31u9000002uiglrntz0w3	123456	3.0000	3.0000	Test A
cmnj177d90003x1igl09typa8	cmnj177d80002x1ign5ztegxu	cmni31u9000002uiglrntz0w3	123456	3.0000	0.0000	Test A
cmnj1cjc2000392igxrmm93jl	cmnj1cjc1000292igogr1a5yt	cmni31u9000002uiglrntz0w3	123456	2.0000	0.0000	Test A
\.


--
-- Data for Name: stock_transfers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock_transfers (id, reference, "fromWarehouseId", "toWarehouseId", status, notes, "dispatchedAt", "completedAt", "createdAt", "updatedAt") FROM stdin;
cmnj0q0ko0000hrigrf3zea3l	TRF-20260403-B2KO	cmni10hvj0001d0igp9tshlgc	cmni10hv50000d0ig530dr2r0	RECEIVED	\N	2026-04-03 14:48:08.698	2026-04-03 15:00:30.729	2026-04-03 14:47:54.985	2026-04-03 15:00:30.73
cmnj177d80002x1ign5ztegxu	TRF-20260403-JN47	cmni10hv50000d0ig530dr2r0	cmni10hvj0001d0igp9tshlgc	IN_TRANSIT	\N	2026-04-03 15:04:38.738	\N	2026-04-03 15:01:16.94	2026-04-03 15:04:38.747
cmnj1cjc1000292igogr1a5yt	TRF-20260403-VNDL	cmni10hvj0001d0igp9tshlgc	cmni10hv50000d0ig530dr2r0	DRAFT	Test	\N	\N	2026-04-03 15:05:25.729	2026-04-03 15:05:25.729
\.


--
-- Data for Name: supplier_products; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.supplier_products (id, "supplierId", "productId", "supplierSku", "lastUnitCost", currency, "updatedAt") FROM stdin;
cmnj6dg4j0002mmiggwwsqhpe	cmnj5xh0x0000a1ig4x6426lp	cmni31u9000002uiglrntz0w3	\N	0.500000	EUR	2026-04-03 22:34:21.458
\.


--
-- Data for Name: suppliers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.suppliers (id, name, "contactName", email, phone, "addressLine1", "addressLine2", city, county, postcode, country, currency, "taxRateId", "vatNumber", "accountNumber", "paymentTermsDays", notes, active, "createdAt", "updatedAt") FROM stdin;
cmnj5xh0x0000a1ig4x6426lp	Linneo SRL	Martin Seco Velo	leroy@linneo.tech	+341234567890	1 Street	\N	Town	\N	12345	Spain	EUR	\N	ES1234567789	\N	0	\N	t	2026-04-03 17:13:40.977	2026-04-03 17:52:41.111
\.


--
-- Data for Name: tax_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tax_rates (id, name, rate, type, "countryCode", active, "isDefault", "createdAt", "updatedAt", "usedFor", "xeroTaxType") FROM stdin;
cmni10hz00004d0igczink6tp	UK Standard Rate (20%)	0.2000	VAT	GB	t	t	2026-04-02 22:08:17.916	2026-04-02 22:08:17.916	BOTH	\N
cmni10hzh0005d0ig4yibw556	UK Reduced Rate (5%)	0.0500	VAT	GB	t	f	2026-04-02 22:08:17.933	2026-04-02 22:08:17.933	BOTH	\N
cmni10hzl0006d0igu6gxu0nh	Zero Rated (0%)	0.0000	VAT	\N	t	f	2026-04-02 22:08:17.937	2026-04-02 22:08:17.937	BOTH	\N
cmni10i020007d0ig0r7cfcn3	EU Standard Rate (20%)	0.2000	VAT	\N	t	f	2026-04-02 22:08:17.954	2026-04-02 22:08:17.954	BOTH	\N
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, email, name, "passwordHash", role, "totpSecret", "totpEnabled", active, "lastLoginAt", "createdAt", "updatedAt", "pictureUrl") FROM stdin;
cmni10iea0008d0igxzpikwbu	admin@example.com	Jan	$2b$12$iu83CohelpumtHMJ1IrHpuD8O4XMtBl0b0X4pR2f/pR/yxdEWOMFa	ADMIN	\N	f	t	\N	2026-04-02 22:08:18.466	2026-04-05 21:08:50.831	/uploads/avatars/cmni10iea0008d0igxzpikwbu.png?t=1775423330831
\.


--
-- Data for Name: warehouses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.warehouses (id, code, name, type, "availableForSale", "syncToWoocommerce", "addressLine1", "addressLine2", city, postcode, country, "isDefault", "defaultReturnWarehouse", active, "createdAt", "updatedAt") FROM stdin;
cmni10hv50000d0ig530dr2r0	EAR2	Earith 2	STANDARD	t	t	\N	\N	\N	\N	GB	t	f	t	2026-04-02 22:08:17.777	2026-04-02 22:08:17.777
cmni10hvj0001d0igp9tshlgc	CBG	Cambridge	STANDARD	t	t	\N	\N	\N	\N	GB	f	f	t	2026-04-02 22:08:17.791	2026-04-02 22:08:17.791
cmni10hvu0002d0igdbmhh6vu	RES	Restock	RESTOCK	f	f	\N	\N	\N	\N	GB	f	f	t	2026-04-02 22:08:17.802	2026-04-02 22:08:17.802
cmni10hwb0003d0igy96n0o9q	QUA	Quarantine	QUARANTINE	f	f	\N	\N	\N	\N	GB	f	t	t	2026-04-02 22:08:17.819	2026-04-02 22:08:17.819
\.


--
-- Data for Name: wc_sync_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.wc_sync_logs (id, direction, status, "entityType", "entityId", "wcId", payload, "errorMessage", "syncedAt", "createdAt") FROM stdin;
\.


--
-- Data for Name: xero_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.xero_accounts (id, "xeroId", code, name, type, "taxType", active, "syncedAt") FROM stdin;
\.


--
-- Data for Name: xero_sync_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.xero_sync_logs (id, type, status, "referenceType", "referenceId", "xeroTransactionId", payload, "errorMessage", "syncedAt", "createdAt") FROM stdin;
\.


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: activity_logs activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_logs
    ADD CONSTRAINT activity_logs_pkey PRIMARY KEY (id);


--
-- Name: adjustment_reasons adjustment_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adjustment_reasons
    ADD CONSTRAINT adjustment_reasons_pkey PRIMARY KEY (id);


--
-- Name: bom_items bom_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_items
    ADD CONSTRAINT bom_items_pkey PRIMARY KEY (id);


--
-- Name: boms boms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boms
    ADD CONSTRAINT boms_pkey PRIMARY KEY (id);


--
-- Name: cogs_entries cogs_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cogs_entries
    ADD CONSTRAINT cogs_entries_pkey PRIMARY KEY (id);


--
-- Name: cost_layers cost_layers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_layers
    ADD CONSTRAINT cost_layers_pkey PRIMARY KEY (id);


--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies
    ADD CONSTRAINT currencies_pkey PRIMARY KEY (code);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: document_templates document_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_templates
    ADD CONSTRAINT document_templates_pkey PRIMARY KEY (id);


--
-- Name: freight_cost_lines freight_cost_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.freight_cost_lines
    ADD CONSTRAINT freight_cost_lines_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (id);


--
-- Name: kit_items kit_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_items
    ADD CONSTRAINT kit_items_pkey PRIMARY KEY (id);


--
-- Name: kits kits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kits
    ADD CONSTRAINT kits_pkey PRIMARY KEY (id);


--
-- Name: landed_cost_links landed_cost_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landed_cost_links
    ADD CONSTRAINT landed_cost_links_pkey PRIMARY KEY (id);


--
-- Name: organisations organisations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organisations
    ADD CONSTRAINT organisations_pkey PRIMARY KEY (id);


--
-- Name: passkeys passkeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: product_components product_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_components
    ADD CONSTRAINT product_components_pkey PRIMARY KEY (id);


--
-- Name: product_options product_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_options
    ADD CONSTRAINT product_options_pkey PRIMARY KEY (id);


--
-- Name: production_orders production_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: purchase_invoice_lines purchase_invoice_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoice_lines
    ADD CONSTRAINT purchase_invoice_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_invoices purchase_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoices
    ADD CONSTRAINT purchase_invoices_pkey PRIMARY KEY (id);


--
-- Name: purchase_order_lines purchase_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: purchase_receipt_lines purchase_receipt_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_receipt_lines
    ADD CONSTRAINT purchase_receipt_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_receipts purchase_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_receipts
    ADD CONSTRAINT purchase_receipts_pkey PRIMARY KEY (id);


--
-- Name: purchase_return_lines purchase_return_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_return_lines
    ADD CONSTRAINT purchase_return_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_returns purchase_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_returns
    ADD CONSTRAINT purchase_returns_pkey PRIMARY KEY (id);


--
-- Name: purchase_units purchase_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_units
    ADD CONSTRAINT purchase_units_pkey PRIMARY KEY (id);


--
-- Name: sales_order_lines sales_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT sales_order_lines_pkey PRIMARY KEY (id);


--
-- Name: sales_order_refund_lines sales_order_refund_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_refund_lines
    ADD CONSTRAINT sales_order_refund_lines_pkey PRIMARY KEY (id);


--
-- Name: sales_order_refunds sales_order_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_refunds
    ADD CONSTRAINT sales_order_refunds_pkey PRIMARY KEY (id);


--
-- Name: sales_orders sales_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT sales_orders_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: stock_count_lines stock_count_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_count_lines
    ADD CONSTRAINT stock_count_lines_pkey PRIMARY KEY (id);


--
-- Name: stock_counts stock_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_pkey PRIMARY KEY (id);


--
-- Name: stock_levels stock_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_levels
    ADD CONSTRAINT stock_levels_pkey PRIMARY KEY (id);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: stock_transfer_lines stock_transfer_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_lines
    ADD CONSTRAINT stock_transfer_lines_pkey PRIMARY KEY (id);


--
-- Name: stock_transfers stock_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_pkey PRIMARY KEY (id);


--
-- Name: supplier_products supplier_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_products
    ADD CONSTRAINT supplier_products_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: tax_rates tax_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_rates
    ADD CONSTRAINT tax_rates_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: warehouses warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);


--
-- Name: wc_sync_logs wc_sync_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wc_sync_logs
    ADD CONSTRAINT wc_sync_logs_pkey PRIMARY KEY (id);


--
-- Name: xero_accounts xero_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xero_accounts
    ADD CONSTRAINT xero_accounts_pkey PRIMARY KEY (id);


--
-- Name: xero_sync_logs xero_sync_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xero_sync_logs
    ADD CONSTRAINT xero_sync_logs_pkey PRIMARY KEY (id);


--
-- Name: activity_logs_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "activity_logs_createdAt_idx" ON public.activity_logs USING btree ("createdAt");


--
-- Name: activity_logs_entityType_entityId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "activity_logs_entityType_entityId_idx" ON public.activity_logs USING btree ("entityType", "entityId");


--
-- Name: activity_logs_level_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_logs_level_idx ON public.activity_logs USING btree (level);


--
-- Name: activity_logs_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_logs_tag_idx ON public.activity_logs USING btree (tag);


--
-- Name: cost_layers_productId_warehouseId_receivedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "cost_layers_productId_warehouseId_receivedAt_idx" ON public.cost_layers USING btree ("productId", "warehouseId", "receivedAt");


--
-- Name: customers_wcCustomerId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "customers_wcCustomerId_key" ON public.customers USING btree ("wcCustomerId");


--
-- Name: document_templates_type_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX document_templates_type_key ON public.document_templates USING btree (type);


--
-- Name: fx_rates_toCurrency_fetchedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "fx_rates_toCurrency_fetchedAt_idx" ON public.fx_rates USING btree ("toCurrency", "fetchedAt");


--
-- Name: landed_cost_links_primaryPoId_freightPoId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "landed_cost_links_primaryPoId_freightPoId_key" ON public.landed_cost_links USING btree ("primaryPoId", "freightPoId");


--
-- Name: passkeys_credentialId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "passkeys_credentialId_key" ON public.passkeys USING btree ("credentialId");


--
-- Name: product_components_productId_componentId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "product_components_productId_componentId_key" ON public.product_components USING btree ("productId", "componentId");


--
-- Name: product_options_productId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "product_options_productId_idx" ON public.product_options USING btree ("productId");


--
-- Name: production_orders_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "production_orders_createdAt_idx" ON public.production_orders USING btree ("createdAt");


--
-- Name: production_orders_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX production_orders_reference_key ON public.production_orders USING btree (reference);


--
-- Name: production_orders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX production_orders_status_idx ON public.production_orders USING btree (status);


--
-- Name: products_parentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "products_parentId_idx" ON public.products USING btree ("parentId");


--
-- Name: products_sku_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_sku_key ON public.products USING btree (sku);


--
-- Name: purchase_orders_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX purchase_orders_reference_key ON public.purchase_orders USING btree (reference);


--
-- Name: sales_orders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_orders_status_idx ON public.sales_orders USING btree (status);


--
-- Name: sales_orders_wcOrderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "sales_orders_wcOrderId_idx" ON public.sales_orders USING btree ("wcOrderId");


--
-- Name: sales_orders_wcOrderId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "sales_orders_wcOrderId_key" ON public.sales_orders USING btree ("wcOrderId");


--
-- Name: sessions_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sessions_token_key ON public.sessions USING btree (token);


--
-- Name: stock_counts_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stock_counts_reference_key ON public.stock_counts USING btree (reference);


--
-- Name: stock_levels_productId_warehouseId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "stock_levels_productId_warehouseId_key" ON public.stock_levels USING btree ("productId", "warehouseId");


--
-- Name: stock_movements_productId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "stock_movements_productId_idx" ON public.stock_movements USING btree ("productId");


--
-- Name: stock_movements_referenceType_referenceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "stock_movements_referenceType_referenceId_idx" ON public.stock_movements USING btree ("referenceType", "referenceId");


--
-- Name: stock_transfers_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stock_transfers_reference_key ON public.stock_transfers USING btree (reference);


--
-- Name: supplier_products_supplierId_productId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "supplier_products_supplierId_productId_key" ON public.supplier_products USING btree ("supplierId", "productId");


--
-- Name: users_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);


--
-- Name: warehouses_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX warehouses_code_key ON public.warehouses USING btree (code);


--
-- Name: wc_sync_logs_entityType_entityId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "wc_sync_logs_entityType_entityId_idx" ON public.wc_sync_logs USING btree ("entityType", "entityId");


--
-- Name: xero_accounts_xeroId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "xero_accounts_xeroId_key" ON public.xero_accounts USING btree ("xeroId");


--
-- Name: xero_sync_logs_referenceType_referenceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "xero_sync_logs_referenceType_referenceId_idx" ON public.xero_sync_logs USING btree ("referenceType", "referenceId");


--
-- Name: activity_logs activity_logs_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_logs
    ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: bom_items bom_items_bomId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_items
    ADD CONSTRAINT "bom_items_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES public.boms(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: bom_items bom_items_componentProductId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_items
    ADD CONSTRAINT "bom_items_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: bom_items bom_items_parentProductId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_items
    ADD CONSTRAINT "bom_items_parentProductId_fkey" FOREIGN KEY ("parentProductId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: cogs_entries cogs_entries_costLayerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cogs_entries
    ADD CONSTRAINT "cogs_entries_costLayerId_fkey" FOREIGN KEY ("costLayerId") REFERENCES public.cost_layers(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: cogs_entries cogs_entries_movementId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cogs_entries
    ADD CONSTRAINT "cogs_entries_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES public.stock_movements(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: cost_layers cost_layers_poLineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_layers
    ADD CONSTRAINT "cost_layers_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES public.purchase_order_lines(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: cost_layers cost_layers_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_layers
    ADD CONSTRAINT "cost_layers_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: cost_layers cost_layers_warehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_layers
    ADD CONSTRAINT "cost_layers_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: freight_cost_lines freight_cost_lines_poId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.freight_cost_lines
    ADD CONSTRAINT "freight_cost_lines_poId_fkey" FOREIGN KEY ("poId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: fx_rates fx_rates_toCurrency_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT "fx_rates_toCurrency_fkey" FOREIGN KEY ("toCurrency") REFERENCES public.currencies(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: kit_items kit_items_componentProductId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_items
    ADD CONSTRAINT "kit_items_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: kit_items kit_items_kitId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_items
    ADD CONSTRAINT "kit_items_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES public.kits(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: kit_items kit_items_parentProductId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_items
    ADD CONSTRAINT "kit_items_parentProductId_fkey" FOREIGN KEY ("parentProductId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: landed_cost_links landed_cost_links_freightPoId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landed_cost_links
    ADD CONSTRAINT "landed_cost_links_freightPoId_fkey" FOREIGN KEY ("freightPoId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: landed_cost_links landed_cost_links_primaryPoId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landed_cost_links
    ADD CONSTRAINT "landed_cost_links_primaryPoId_fkey" FOREIGN KEY ("primaryPoId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: passkeys passkeys_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT "passkeys_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: payments payments_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public.sales_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: payments payments_refundId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "payments_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES public.sales_order_refunds(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: product_components product_components_componentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_components
    ADD CONSTRAINT "product_components_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: product_components product_components_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_components
    ADD CONSTRAINT "product_components_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: product_options product_options_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_options
    ADD CONSTRAINT "product_options_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: production_orders production_orders_bomId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT "production_orders_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES public.boms(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: production_orders production_orders_manufacturerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT "production_orders_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: production_orders production_orders_outputProductId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT "production_orders_outputProductId_fkey" FOREIGN KEY ("outputProductId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: production_orders production_orders_warehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT "production_orders_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: products products_parentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT "products_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: purchase_invoice_lines purchase_invoice_lines_invoiceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoice_lines
    ADD CONSTRAINT "purchase_invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES public.purchase_invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_invoice_lines purchase_invoice_lines_poLineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoice_lines
    ADD CONSTRAINT "purchase_invoice_lines_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES public.purchase_order_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_invoices purchase_invoices_poId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_invoices
    ADD CONSTRAINT "purchase_invoices_poId_fkey" FOREIGN KEY ("poId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_order_lines purchase_order_lines_poId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT "purchase_order_lines_poId_fkey" FOREIGN KEY ("poId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_order_lines purchase_order_lines_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT "purchase_order_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_order_lines purchase_order_lines_purchaseUnitId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT "purchase_order_lines_purchaseUnitId_fkey" FOREIGN KEY ("purchaseUnitId") REFERENCES public.purchase_units(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: purchase_order_lines purchase_order_lines_taxRateId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_lines
    ADD CONSTRAINT "purchase_order_lines_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES public.tax_rates(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: purchase_orders purchase_orders_destinationWarehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT "purchase_orders_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: purchase_orders purchase_orders_supplierId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_receipt_lines purchase_receipt_lines_poLineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_receipt_lines
    ADD CONSTRAINT "purchase_receipt_lines_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES public.purchase_order_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_receipt_lines purchase_receipt_lines_receiptId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_receipt_lines
    ADD CONSTRAINT "purchase_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES public.purchase_receipts(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_receipts purchase_receipts_poId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_receipts
    ADD CONSTRAINT "purchase_receipts_poId_fkey" FOREIGN KEY ("poId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_return_lines purchase_return_lines_poLineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_return_lines
    ADD CONSTRAINT "purchase_return_lines_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES public.purchase_order_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_return_lines purchase_return_lines_returnId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_return_lines
    ADD CONSTRAINT "purchase_return_lines_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES public.purchase_returns(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: purchase_returns purchase_returns_poId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_returns
    ADD CONSTRAINT "purchase_returns_poId_fkey" FOREIGN KEY ("poId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: sales_order_lines sales_order_lines_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT "sales_order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public.sales_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: sales_order_lines sales_order_lines_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT "sales_order_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: sales_order_lines sales_order_lines_taxRateId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_lines
    ADD CONSTRAINT "sales_order_lines_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES public.tax_rates(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: sales_order_refund_lines sales_order_refund_lines_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_refund_lines
    ADD CONSTRAINT "sales_order_refund_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: sales_order_refund_lines sales_order_refund_lines_refundId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_refund_lines
    ADD CONSTRAINT "sales_order_refund_lines_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES public.sales_order_refunds(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: sales_order_refunds sales_order_refunds_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_refunds
    ADD CONSTRAINT "sales_order_refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public.sales_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: sales_order_refunds sales_order_refunds_returnWarehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_order_refunds
    ADD CONSTRAINT "sales_order_refunds_returnWarehouseId_fkey" FOREIGN KEY ("returnWarehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: sales_orders sales_orders_customerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT "sales_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: sales_orders sales_orders_shipFromWarehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_orders
    ADD CONSTRAINT "sales_orders_shipFromWarehouseId_fkey" FOREIGN KEY ("shipFromWarehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: sessions sessions_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: stock_count_lines stock_count_lines_countId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_count_lines
    ADD CONSTRAINT "stock_count_lines_countId_fkey" FOREIGN KEY ("countId") REFERENCES public.stock_counts(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: stock_counts stock_counts_warehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT "stock_counts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: stock_levels stock_levels_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_levels
    ADD CONSTRAINT "stock_levels_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: stock_levels stock_levels_warehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_levels
    ADD CONSTRAINT "stock_levels_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: stock_movements stock_movements_fromWarehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "stock_movements_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: stock_movements stock_movements_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: stock_movements stock_movements_toWarehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "stock_movements_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: stock_transfer_lines stock_transfer_lines_transferId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_lines
    ADD CONSTRAINT "stock_transfer_lines_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES public.stock_transfers(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: stock_transfers stock_transfers_fromWarehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT "stock_transfers_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: stock_transfers stock_transfers_toWarehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT "stock_transfers_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES public.warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: supplier_products supplier_products_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_products
    ADD CONSTRAINT "supplier_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: supplier_products supplier_products_supplierId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_products
    ADD CONSTRAINT "supplier_products_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: suppliers suppliers_taxRateId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT "suppliers_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES public.tax_rates(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: wc_sync_logs wc_sync_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wc_sync_logs
    ADD CONSTRAINT wc_sync_order FOREIGN KEY ("entityId") REFERENCES public.sales_orders(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: wc_sync_logs wc_sync_product; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wc_sync_logs
    ADD CONSTRAINT wc_sync_product FOREIGN KEY ("entityId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: xero_sync_logs xero_sync_cogs; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xero_sync_logs
    ADD CONSTRAINT xero_sync_cogs FOREIGN KEY ("referenceId") REFERENCES public.cogs_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: xero_sync_logs xero_sync_po; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xero_sync_logs
    ADD CONSTRAINT xero_sync_po FOREIGN KEY ("referenceId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict fEK7yH9YMeOsXjcZXdDbaxZtzXb8OhCDLiTVPg6rPChI4CXoCgoz6U7DekZB9RT


#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
type AxiosError = {
  isAxiosError: boolean;
  response?: {
    data?: {
      message?: string;
    };
  };
  message: string;
};

interface PayPalResponse {
  data: unknown;
}

interface PayPalTokenResponse extends PayPalResponse {
  access_token: string;
}

function isAxiosError(error: unknown): error is AxiosError {
  return error !== null && typeof error === 'object' && 'isAxiosError' in error;
}

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  throw new Error('PayPal credentials are required');
}

interface PayPalPaymentToken {
  id?: string;
  customer: {
    id: string;
    email_address?: string;
    phone?: {
      phone_type: string;
      phone_number: {
        national_number: string;
      };
    };
  };
  payment_source: {
    card?: {
      name: string;
      number: string;
      expiry: string;
      security_code: string;
    };
    paypal?: {
      email_address: string;
      account_id?: string;
    };
  };
}

interface PayPalPayment {
  id?: string;
  intent: string;
  payer: {
    payment_method: string;
    funding_instruments?: Array<{
      credit_card?: {
        number: string;
        type: string;
        expire_month: number;
        expire_year: number;
        cvv2: string;
        first_name: string;
        last_name: string;
      };
    }>;
  };
  transactions: Array<{
    amount: {
      total: string;
      currency: string;
    };
    description?: string;
  }>;
}

interface PayPalPayout {
  sender_batch_header: {
    sender_batch_id: string;
    email_subject?: string;
    recipient_type?: string;
  };
  items: Array<{
    recipient_type: string;
    amount: {
      value: string;
      currency: string;
    };
    receiver: string;
    note?: string;
    sender_item_id?: string;
  }>;
}

interface PayPalReferencedPayout {
  referenced_payouts: Array<{
    item_id: string;
    processing_state: {
      status: string;
      reason?: string;
    };
    reference_id: string;
    reference_type: string;
    payout_amount: {
      currency_code: string;
      value: string;
    };
    payout_destination: string;
  }>;
}

interface PayPalOrder {
  id?: string;
  intent: 'CAPTURE' | 'AUTHORIZE';
  purchase_units: Array<{
    amount: {
      currency_code: string;
      value: string;
    };
    description?: string;
    reference_id?: string;
  }>;
}

interface PayPalPartnerReferral {
  individual_owners: Array<{
    names: Array<{
      prefix?: string;
      given_name: string;
      surname: string;
      middle_name?: string;
      suffix?: string;
    }>;
    citizenship?: string;
    addresses?: Array<{
      address_line_1: string;
      address_line_2?: string;
      admin_area_2: string;
      admin_area_1: string;
      postal_code: string;
      country_code: string;
    }>;
  }>;
  business_entity: {
    business_type: {
      type: string;
      subtype?: string;
    };
    business_name: string;
    business_phone?: {
      country_code: string;
      national_number: string;
    };
  };
  email: string;
}

interface PayPalWebProfile {
  id?: string;
  name: string;
  presentation: {
    brand_name?: string;
    logo_image?: string;
    locale_code?: string;
  };
  input_fields: {
    no_shipping?: number;
    address_override?: number;
  };
  flow_config: {
    landing_page_type?: string;
    bank_txn_pending_url?: string;
  };
}

interface PayPalProduct {
  id?: string;
  name: string;
  description: string;
  type: 'PHYSICAL' | 'DIGITAL' | 'SERVICE';
  category: string;
  image_url?: string;
  home_url?: string;
}

interface PayPalDispute {
  id: string;
  reason: string;
  status: string;
  disputed_transactions: Array<{
    id: string;
    amount: {
      currency_code: string;
      value: string;
    };
  }>;
}

interface PayPalInvoice {
  id?: string;
  detail: {
    invoice_number: string;
    reference: string;
    currency_code: string;
  };
  primary_recipients: Array<{
    billing_info: {
      email_address: string;
    };
  }>;
  items: Array<{
    name: string;
    quantity: string;
    unit_amount: {
      currency_code: string;
      value: string;
    };
  }>;
}

interface PayPalIdentityTokenInfo {
  client_id: string;
  user_id: string;
  scopes: string[];
}

class PayPalServer {
  private server: Server;
  private accessToken: string | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'paypal-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await axios.post<PayPalTokenResponse>(
      'https://api-m.sandbox.paypal.com/v1/oauth2/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${auth}`,
        },
      }
    );

    this.accessToken = response.data.access_token;
    if (!this.accessToken) {
      throw new Error('Failed to obtain access token');
    }
    return this.accessToken;
  }

  private validatePaymentToken(args: unknown): PayPalPaymentToken {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid payment token data');
    }

    const token = args as Record<string, unknown>;
    
    if (!token.customer || typeof token.customer !== 'object' ||
        !token.payment_source || typeof token.payment_source !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required payment token fields');
    }

    const customer = token.customer as Record<string, unknown>;
    if (typeof customer.id !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid customer ID');
    }

    const validatedToken: PayPalPaymentToken = {
      customer: {
        id: customer.id
      },
      payment_source: {}
    };

    if (typeof customer.email_address === 'string') {
      validatedToken.customer.email_address = customer.email_address;
    }

    const source = token.payment_source as Record<string, unknown>;
    if (source.card && typeof source.card === 'object') {
      const card = source.card as Record<string, unknown>;
      if (typeof card.name === 'string' &&
          typeof card.number === 'string' &&
          typeof card.expiry === 'string' &&
          typeof card.security_code === 'string') {
        validatedToken.payment_source.card = {
          name: card.name,
          number: card.number,
          expiry: card.expiry,
          security_code: card.security_code
        };
      }
    }

    if (source.paypal && typeof source.paypal === 'object') {
      const paypal = source.paypal as Record<string, unknown>;
      if (typeof paypal.email_address === 'string') {
        validatedToken.payment_source.paypal = {
          email_address: paypal.email_address
        };
        if (typeof paypal.account_id === 'string') {
          validatedToken.payment_source.paypal.account_id = paypal.account_id;
        }
      }
    }

    return validatedToken;
  }

  private validatePayment(args: unknown): PayPalPayment {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid payment data');
    }

    const payment = args as Record<string, unknown>;
    
    if (typeof payment.intent !== 'string' ||
        !payment.payer || typeof payment.payer !== 'object' ||
        !Array.isArray(payment.transactions) ||
        payment.transactions.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required payment fields');
    }

    const payer = payment.payer as Record<string, unknown>;
    if (typeof payer.payment_method !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid payment method');
    }

    const transactions = payment.transactions.map(transaction => {
      const trans = transaction as Record<string, unknown>;
      if (!trans.amount || typeof trans.amount !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid transaction amount');
      }

      const amount = trans.amount as Record<string, unknown>;
      if (typeof amount.total !== 'string' || typeof amount.currency !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid amount fields');
      }

      const validatedTransaction = {
        amount: {
          total: amount.total,
          currency: amount.currency
        }
      };

      if (typeof trans.description === 'string') {
        (validatedTransaction as any).description = trans.description;
      }

      return validatedTransaction;
    });

    return {
      intent: payment.intent,
      payer: {
        payment_method: payer.payment_method,
        funding_instruments: payer.funding_instruments as PayPalPayment['payer']['funding_instruments']
      },
      transactions
    };
  }

  private validatePayout(args: unknown): PayPalPayout {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid payout data');
    }

    const payout = args as Record<string, unknown>;
    
    if (!payout.sender_batch_header || typeof payout.sender_batch_header !== 'object' ||
        !Array.isArray(payout.items) || payout.items.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required payout fields');
    }

    const header = payout.sender_batch_header as Record<string, unknown>;
    if (typeof header.sender_batch_id !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid sender batch ID');
    }

    const items = payout.items.map(item => {
      const payoutItem = item as Record<string, unknown>;
      if (typeof payoutItem.recipient_type !== 'string' ||
          !payoutItem.amount || typeof payoutItem.amount !== 'object' ||
          typeof payoutItem.receiver !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid payout item');
      }

      const amount = payoutItem.amount as Record<string, unknown>;
      if (typeof amount.value !== 'string' || typeof amount.currency !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid amount fields');
      }

      const validatedItem: PayPalPayout['items'][0] = {
        recipient_type: payoutItem.recipient_type,
        amount: {
          value: amount.value,
          currency: amount.currency
        },
        receiver: payoutItem.receiver
      };

      if (typeof payoutItem.note === 'string') {
        validatedItem.note = payoutItem.note;
      }
      if (typeof payoutItem.sender_item_id === 'string') {
        validatedItem.sender_item_id = payoutItem.sender_item_id;
      }

      return validatedItem;
    });

    return {
      sender_batch_header: {
        sender_batch_id: header.sender_batch_id,
        email_subject: typeof header.email_subject === 'string' ? header.email_subject : undefined,
        recipient_type: typeof header.recipient_type === 'string' ? header.recipient_type : undefined
      },
      items
    };
  }

  private validateReferencedPayout(args: unknown): PayPalReferencedPayout {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid referenced payout data');
    }

    const payout = args as Record<string, unknown>;
    
    if (!Array.isArray(payout.referenced_payouts) || payout.referenced_payouts.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing referenced payouts');
    }

    const referenced_payouts = payout.referenced_payouts.map(ref => {
      const refPayout = ref as Record<string, unknown>;
      if (typeof refPayout.reference_id !== 'string' ||
          typeof refPayout.reference_type !== 'string' ||
          !refPayout.payout_amount || typeof refPayout.payout_amount !== 'object' ||
          typeof refPayout.payout_destination !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid referenced payout');
      }

      const amount = refPayout.payout_amount as Record<string, unknown>;
      if (typeof amount.currency_code !== 'string' || typeof amount.value !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid amount fields');
      }

      return {
        item_id: typeof refPayout.item_id === 'string' ? refPayout.item_id : '',
        processing_state: {
          status: typeof refPayout.processing_state === 'object' ? 
            (refPayout.processing_state as any).status || '' : '',
          reason: typeof refPayout.processing_state === 'object' ? 
            (refPayout.processing_state as any).reason : undefined
        },
        reference_id: refPayout.reference_id,
        reference_type: refPayout.reference_type,
        payout_amount: {
          currency_code: amount.currency_code,
          value: amount.value
        },
        payout_destination: refPayout.payout_destination
      };
    });

    return { referenced_payouts };
  }

  private validatePayPalOrder(args: unknown): PayPalOrder {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid order data');
    }

    const order = args as Record<string, unknown>;
    
    if (!['CAPTURE', 'AUTHORIZE'].includes(order.intent as string) ||
        !Array.isArray(order.purchase_units) ||
        order.purchase_units.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required order fields');
    }

    const purchase_units = order.purchase_units.map(unit => {
      const unitObj = unit as Record<string, unknown>;
      if (!unitObj.amount || typeof unitObj.amount !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid purchase unit amount');
      }

      const amount = unitObj.amount as Record<string, unknown>;
      if (typeof amount.currency_code !== 'string' || typeof amount.value !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid amount fields');
      }

      const validatedUnit: PayPalOrder['purchase_units'][0] = {
        amount: {
          currency_code: amount.currency_code,
          value: amount.value
        }
      };

      if (typeof unitObj.description === 'string') {
        validatedUnit.description = unitObj.description;
      }
      if (typeof unitObj.reference_id === 'string') {
        validatedUnit.reference_id = unitObj.reference_id;
      }

      return validatedUnit;
    });

    return {
      intent: order.intent as 'CAPTURE' | 'AUTHORIZE',
      purchase_units
    };
  }

  private validatePartnerReferral(args: unknown): PayPalPartnerReferral {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid partner referral data');
    }

    const referral = args as Record<string, unknown>;
    
    if (!Array.isArray(referral.individual_owners) ||
        !referral.business_entity ||
        typeof referral.email !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required referral fields');
    }

    const individual_owners = referral.individual_owners.map(owner => {
      const ownerObj = owner as Record<string, unknown>;
      if (!Array.isArray(ownerObj.names) || ownerObj.names.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid owner names');
      }

      const names = ownerObj.names.map(name => {
        const nameObj = name as Record<string, unknown>;
        if (typeof nameObj.given_name !== 'string' || typeof nameObj.surname !== 'string') {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid name fields');
        }
        return {
          given_name: nameObj.given_name,
          surname: nameObj.surname
        };
      });

      return { names };
    });

    const business = referral.business_entity as Record<string, unknown>;
    if (!business.business_type || typeof business.business_name !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid business entity');
    }

    const business_type = business.business_type as Record<string, unknown>;
    if (typeof business_type.type !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid business type');
    }

    return {
      individual_owners,
      business_entity: {
        business_type: {
          type: business_type.type
        },
        business_name: business.business_name
      },
      email: referral.email
    };
  }

  private validateWebProfile(args: unknown): PayPalWebProfile {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid web profile data');
    }

    const profile = args as Record<string, unknown>;
    
    if (typeof profile.name !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required profile name');
    }

    const webProfile: PayPalWebProfile = {
      name: profile.name,
      presentation: {},
      input_fields: {},
      flow_config: {}
    };

    if (profile.presentation && typeof profile.presentation === 'object') {
      const pres = profile.presentation as Record<string, unknown>;
      if (typeof pres.brand_name === 'string') webProfile.presentation.brand_name = pres.brand_name;
      if (typeof pres.logo_image === 'string') webProfile.presentation.logo_image = pres.logo_image;
      if (typeof pres.locale_code === 'string') webProfile.presentation.locale_code = pres.locale_code;
    }

    if (profile.input_fields && typeof profile.input_fields === 'object') {
      const fields = profile.input_fields as Record<string, unknown>;
      if (typeof fields.no_shipping === 'number') webProfile.input_fields.no_shipping = fields.no_shipping;
      if (typeof fields.address_override === 'number') webProfile.input_fields.address_override = fields.address_override;
    }

    if (profile.flow_config && typeof profile.flow_config === 'object') {
      const flow = profile.flow_config as Record<string, unknown>;
      if (typeof flow.landing_page_type === 'string') webProfile.flow_config.landing_page_type = flow.landing_page_type;
      if (typeof flow.bank_txn_pending_url === 'string') webProfile.flow_config.bank_txn_pending_url = flow.bank_txn_pending_url;
    }

    return webProfile;
  }

  private validatePayPalProduct(args: unknown): PayPalProduct {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid product data');
    }

    const product = args as Record<string, unknown>;
    
    if (typeof product.name !== 'string' ||
        typeof product.description !== 'string' ||
        !['PHYSICAL', 'DIGITAL', 'SERVICE'].includes(product.type as string) ||
        typeof product.category !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required product fields');
    }

    const validatedProduct: PayPalProduct = {
      name: product.name,
      description: product.description,
      type: product.type as 'PHYSICAL' | 'DIGITAL' | 'SERVICE',
      category: product.category,
    };

    if (typeof product.image_url === 'string') {
      validatedProduct.image_url = product.image_url;
    }
    if (typeof product.home_url === 'string') {
      validatedProduct.home_url = product.home_url;
    }

    return validatedProduct;
  }

  private validatePaginationParams(args: unknown): { page_size?: number; page?: number } {
    if (typeof args !== 'object' || !args) {
      return {};
    }

    const params = args as Record<string, unknown>;
    const validated: { page_size?: number; page?: number } = {};

    if (typeof params.page_size === 'number' && params.page_size >= 1 && params.page_size <= 100) {
      validated.page_size = params.page_size;
    }
    if (typeof params.page === 'number' && params.page >= 1) {
      validated.page = params.page;
    }

    return validated;
  }

  private validateDisputeParams(args: unknown): { dispute_id: string } {
    if (typeof args !== 'object' || !args || typeof (args as any).dispute_id !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid dispute ID');
    }
    return { dispute_id: (args as any).dispute_id };
  }

  private validateTokenParams(args: unknown): { access_token: string } {
    if (typeof args !== 'object' || !args || typeof (args as any).access_token !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid access token');
    }
    return { access_token: (args as any).access_token };
  }

  private validatePayPalInvoice(args: unknown): PayPalInvoice {
    if (typeof args !== 'object' || !args) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid invoice data');
    }

    const invoice = args as Record<string, unknown>;
    
    if (!invoice.detail || typeof invoice.detail !== 'object' ||
        !Array.isArray(invoice.primary_recipients) || invoice.primary_recipients.length === 0 ||
        !Array.isArray(invoice.items) || invoice.items.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required invoice fields');
    }

    const detail = invoice.detail as Record<string, unknown>;
    if (typeof detail.invoice_number !== 'string' ||
        typeof detail.reference !== 'string' ||
        typeof detail.currency_code !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid invoice detail fields');
    }

    const recipient = invoice.primary_recipients[0] as Record<string, unknown>;
    if (!recipient.billing_info || typeof recipient.billing_info !== 'object' ||
        typeof (recipient.billing_info as any).email_address !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid recipient information');
    }

    const items = invoice.items as Array<Record<string, unknown>>;
    const validatedItems = items.map(item => {
      if (typeof item.name !== 'string' ||
          typeof item.quantity !== 'string' ||
          !item.unit_amount || typeof item.unit_amount !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid invoice item');
      }

      const amount = item.unit_amount as Record<string, unknown>;
      if (typeof amount.currency_code !== 'string' || typeof amount.value !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid item amount');
      }

      return {
        name: item.name,
        quantity: item.quantity,
        unit_amount: {
          currency_code: amount.currency_code,
          value: amount.value
        }
      };
    });

    return {
      detail: {
        invoice_number: detail.invoice_number,
        reference: detail.reference,
        currency_code: detail.currency_code
      },
      primary_recipients: [{
        billing_info: {
          email_address: (recipient.billing_info as any).email_address
        }
      }],
      items: validatedItems
    };
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_payment_token',
          description: 'Create a payment token',
          inputSchema: {
            type: 'object',
            properties: {
              customer: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email_address: { type: 'string' }
                },
                required: ['id']
              },
              payment_source: {
                type: 'object',
                properties: {
                  card: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      number: { type: 'string' },
                      expiry: { type: 'string' },
                      security_code: { type: 'string' }
                    }
                  },
                  paypal: {
                    type: 'object',
                    properties: {
                      email_address: { type: 'string' }
                    }
                  }
                }
              }
            },
            required: ['customer', 'payment_source']
          }
        },
        {
          name: 'create_payment',
          description: 'Create a payment',
          inputSchema: {
            type: 'object',
            properties: {
              intent: { type: 'string' },
              payer: {
                type: 'object',
                properties: {
                  payment_method: { type: 'string' },
                  funding_instruments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        credit_card: {
                          type: 'object',
                          properties: {
                            number: { type: 'string' },
                            type: { type: 'string' },
                            expire_month: { type: 'number' },
                            expire_year: { type: 'number' },
                            cvv2: { type: 'string' },
                            first_name: { type: 'string' },
                            last_name: { type: 'string' }
                          }
                        }
                      }
                    }
                  }
                },
                required: ['payment_method']
              },
              transactions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    amount: {
                      type: 'object',
                      properties: {
                        total: { type: 'string' },
                        currency: { type: 'string' }
                      },
                      required: ['total', 'currency']
                    },
                    description: { type: 'string' }
                  },
                  required: ['amount']
                }
              }
            },
            required: ['intent', 'payer', 'transactions']
          }
        },
        {
          name: 'create_payout',
          description: 'Create a batch payout',
          inputSchema: {
            type: 'object',
            properties: {
              sender_batch_header: {
                type: 'object',
                properties: {
                  sender_batch_id: { type: 'string' },
                  email_subject: { type: 'string' },
                  recipient_type: { type: 'string' }
                },
                required: ['sender_batch_id']
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    recipient_type: { type: 'string' },
                    amount: {
                      type: 'object',
                      properties: {
                        value: { type: 'string' },
                        currency: { type: 'string' }
                      },
                      required: ['value', 'currency']
                    },
                    receiver: { type: 'string' },
                    note: { type: 'string' },
                    sender_item_id: { type: 'string' }
                  },
                  required: ['recipient_type', 'amount', 'receiver']
                }
              }
            },
            required: ['sender_batch_header', 'items']
          }
        },
        {
          name: 'create_referenced_payout',
          description: 'Create a referenced payout',
          inputSchema: {
            type: 'object',
            properties: {
              referenced_payouts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    reference_id: { type: 'string' },
                    reference_type: { type: 'string' },
                    payout_amount: {
                      type: 'object',
                      properties: {
                        currency_code: { type: 'string' },
                        value: { type: 'string' }
                      },
                      required: ['currency_code', 'value']
                    },
                    payout_destination: { type: 'string' }
                  },
                  required: ['reference_id', 'reference_type', 'payout_amount', 'payout_destination']
                }
              }
            },
            required: ['referenced_payouts']
          }
        },
        {
          name: 'create_order',
          description: 'Create a new order in PayPal',
          inputSchema: {
            type: 'object',
            properties: {
              intent: { 
                type: 'string',
                enum: ['CAPTURE', 'AUTHORIZE']
              },
              purchase_units: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    amount: {
                      type: 'object',
                      properties: {
                        currency_code: { type: 'string' },
                        value: { type: 'string' }
                      },
                      required: ['currency_code', 'value']
                    },
                    description: { type: 'string' },
                    reference_id: { type: 'string' }
                  },
                  required: ['amount']
                }
              }
            },
            required: ['intent', 'purchase_units']
          }
        },
        {
          name: 'create_partner_referral',
          description: 'Create a partner referral',
          inputSchema: {
            type: 'object',
            properties: {
              individual_owners: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    names: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          given_name: { type: 'string' },
                          surname: { type: 'string' }
                        },
                        required: ['given_name', 'surname']
                      }
                    }
                  },
                  required: ['names']
                }
              },
              business_entity: {
                type: 'object',
                properties: {
                  business_type: {
                    type: 'object',
                    properties: {
                      type: { type: 'string' }
                    },
                    required: ['type']
                  },
                  business_name: { type: 'string' }
                },
                required: ['business_type', 'business_name']
              },
              email: { type: 'string' }
            },
            required: ['individual_owners', 'business_entity', 'email']
          }
        },
        {
          name: 'create_web_profile',
          description: 'Create a web experience profile',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              presentation: {
                type: 'object',
                properties: {
                  brand_name: { type: 'string' },
                  logo_image: { type: 'string' },
                  locale_code: { type: 'string' }
                }
              },
              input_fields: {
                type: 'object',
                properties: {
                  no_shipping: { type: 'number' },
                  address_override: { type: 'number' }
                }
              },
              flow_config: {
                type: 'object',
                properties: {
                  landing_page_type: { type: 'string' },
                  bank_txn_pending_url: { type: 'string' }
                }
              }
            },
            required: ['name']
          }
        },
        {
          name: 'create_product',
          description: 'Create a new product in PayPal',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              type: { 
                type: 'string',
                enum: ['PHYSICAL', 'DIGITAL', 'SERVICE']
              },
              category: { type: 'string' },
              image_url: { type: 'string' },
              home_url: { type: 'string' }
            },
            required: ['name', 'description', 'type', 'category']
          }
        },
        {
          name: 'list_products',
          description: 'List all products',
          inputSchema: {
            type: 'object',
            properties: {
              page_size: { type: 'number', minimum: 1, maximum: 100 },
              page: { type: 'number', minimum: 1 }
            }
          }
        },
        {
          name: 'get_dispute',
          description: 'Get details of a dispute',
          inputSchema: {
            type: 'object',
            properties: {
              dispute_id: { type: 'string' }
            },
            required: ['dispute_id']
          }
        },
        {
          name: 'get_userinfo',
          description: 'Get user info from identity token',
          inputSchema: {
            type: 'object',
            properties: {
              access_token: { type: 'string' }
            },
            required: ['access_token']
          }
        },
        {
          name: 'create_invoice',
          description: 'Create a new invoice',
          inputSchema: {
            type: 'object',
            properties: {
              invoice_number: { type: 'string' },
              reference: { type: 'string' },
              currency_code: { type: 'string' },
              recipient_email: { type: 'string' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    quantity: { type: 'string' },
                    unit_amount: {
                      type: 'object',
                      properties: {
                        currency_code: { type: 'string' },
                        value: { type: 'string' }
                      }
                    }
                  }
                }
              }
            },
            required: ['invoice_number', 'reference', 'currency_code', 'recipient_email', 'items']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!request.params.arguments) {
        throw new McpError(ErrorCode.InvalidParams, 'Arguments are required');
      }

      const accessToken = await this.getAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      };

      try {
        switch (request.params.name) {
          case 'create_payment_token': {
            const args = this.validatePaymentToken(request.params.arguments);
            const response = await axios.post<PayPalPaymentToken>(
              'https://api-m.sandbox.paypal.com/v3/payment-tokens',
              args,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'create_payment': {
            const args = this.validatePayment(request.params.arguments);
            const response = await axios.post<PayPalPayment>(
              'https://api-m.sandbox.paypal.com/v2/payments/payment',
              args,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'create_payout': {
            const args = this.validatePayout(request.params.arguments);
            const response = await axios.post<PayPalPayout>(
              'https://api-m.sandbox.paypal.com/v1/payments/payouts',
              args,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'create_referenced_payout': {
            const args = this.validateReferencedPayout(request.params.arguments);
            const response = await axios.post<PayPalReferencedPayout>(
              'https://api-m.sandbox.paypal.com/v1/payments/referenced-payouts',
              args,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'create_order': {
            const args = this.validatePayPalOrder(request.params.arguments);
            const response = await axios.post<PayPalOrder>(
              'https://api-m.sandbox.paypal.com/v2/checkout/orders',
              args,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'create_partner_referral': {
            const args = this.validatePartnerReferral(request.params.arguments);
            const response = await axios.post<PayPalPartnerReferral>(
              'https://api-m.sandbox.paypal.com/v2/customer/partner-referrals',
              args,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'create_web_profile': {
            const args = this.validateWebProfile(request.params.arguments);
            const response = await axios.post<PayPalWebProfile>(
              'https://api-m.sandbox.paypal.com/v1/payment-experience/web-profiles',
              args,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'create_product': {
            const args = this.validatePayPalProduct(request.params.arguments);
            const response = await axios.post<PayPalResponse>(
              'https://api-m.sandbox.paypal.com/v1/catalogs/products',
              args,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'list_products': {
            const args = this.validatePaginationParams(request.params.arguments);
            const params = new URLSearchParams({
              page_size: args.page_size?.toString() || '10',
              page: args.page?.toString() || '1'
            });
            const response = await axios.get<PayPalResponse>(
              `https://api-m.sandbox.paypal.com/v1/catalogs/products?${params}`,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'get_dispute': {
            const args = this.validateDisputeParams(request.params.arguments);
            const response = await axios.get<PayPalDispute>(
              `https://api-m.sandbox.paypal.com/v1/customer/disputes/${args.dispute_id}`,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'get_userinfo': {
            const args = this.validateTokenParams(request.params.arguments);
            const response = await axios.get<PayPalIdentityTokenInfo>(
              'https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo',
              {
                headers: {
                  Authorization: `Bearer ${args.access_token}`,
                  'Content-Type': 'application/json'
                }
              }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case 'create_invoice': {
            const args = this.validatePayPalInvoice(request.params.arguments);
            const invoiceData: PayPalInvoice = {
              detail: {
                invoice_number: args.detail.invoice_number,
                reference: args.detail.reference,
                currency_code: args.detail.currency_code
              },
              primary_recipients: [{
                billing_info: {
                  email_address: args.primary_recipients[0].billing_info.email_address
                }
              }],
              items: args.items
            };
            const response = await axios.post<PayPalInvoice>(
              'https://api-m.sandbox.paypal.com/v2/invoicing/invoices',
              invoiceData,
              { headers }
            );
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        if (isAxiosError(error)) {
          return {
            content: [{
              type: 'text',
              text: `PayPal API error: ${error.response?.data?.message || error.message}`
            }],
            isError: true
          };
        }
        const err = error as Error;
        throw new McpError(ErrorCode.InternalError, err.message || 'An unexpected error occurred');
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PayPal MCP server running on stdio');
  }
}

const server = new PayPalServer();
server.run().catch(console.error);

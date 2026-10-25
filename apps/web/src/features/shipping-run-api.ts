import { createShippingRunInputSchema, createManualShippingRunInputSchema, addShippingTicketInputSchema, appendShippingTicketMembersInputSchema, correctShippingRunInputSchema, shippingRunDetailSchema, shippingRunListSchema, type CreateShippingRunInput, type RetryShippingRunInput, type CreateManualShippingRunInput, type AddShippingTicketInput, type AppendShippingTicketMembersInput, type CorrectShippingRunInput } from '@scm/contracts';
import { request } from '../api';

const base = '/api/v1/shipping-runs';
export const shippingRunApi = {
  list: async () => shippingRunListSchema.parse(await request(base)),
  detail: async (id: string) => shippingRunDetailSchema.parse(await request(`${base}/${encodeURIComponent(id)}`)),
  create: async (input: CreateShippingRunInput) => shippingRunDetailSchema.parse(await request(base, { method: 'POST', body: JSON.stringify(createShippingRunInputSchema.parse(input)) })),
  createManual: async (input: CreateManualShippingRunInput) => shippingRunDetailSchema.parse(await request(`${base}/manual`, { method: 'POST', body: JSON.stringify(createManualShippingRunInputSchema.parse(input)) })),
  addTicket: async (id: string, input: AddShippingTicketInput) => shippingRunDetailSchema.parse(await request(`${base}/${encodeURIComponent(id)}/tickets`, { method: 'POST', body: JSON.stringify(addShippingTicketInputSchema.parse(input)) })),
  appendMembers: async (id: string, ticketId: string, input: AppendShippingTicketMembersInput) => shippingRunDetailSchema.parse(await request(`${base}/${encodeURIComponent(id)}/tickets/${encodeURIComponent(ticketId)}/members`, { method: 'POST', body: JSON.stringify(appendShippingTicketMembersInputSchema.parse(input)) })),
  correct: async (id: string, input: CorrectShippingRunInput) => shippingRunDetailSchema.parse(await request(`${base}/${encodeURIComponent(id)}/correction`, { method: 'POST', body: JSON.stringify(correctShippingRunInputSchema.parse(input)) })),
  retry: async (id: string, input: RetryShippingRunInput) => shippingRunDetailSchema.parse(await request(`${base}/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify(input) })),
};

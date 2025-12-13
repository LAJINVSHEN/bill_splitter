import apiClient from '@/services/api';

export interface SplitwiseMe {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  display_name: string;
}

export interface SplitwiseUser {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  display_name: string;
}

export interface SplitwiseGroup {
  id: number;
  name: string;
  members: SplitwiseUser[];
}

export interface SplitwiseOAuth2StartRequest {
  consumer_key: string;
  consumer_secret: string;
  api_key?: string;
  frontend_origin?: string;
}

export interface SplitwiseOAuth2StartResponse {
  authorization_url: string;
  state: string;
  redirect_uri: string;
}

export interface SplitwiseConnectRequest {
  api_key: string;
}

export interface SplitwiseConnectResponse {
  session_id: string;
  me: SplitwiseMe;
}

export interface SplitwiseExpenseShare {
  user_id: number;
  owed_share: string;
  paid_share: string;
}

export interface SplitwiseCreateExpenseRequest {
  session_id: string;
  group_id: number;
  description: string;
  cost: string;
  currency_code?: string;
  date?: string;
  shares: SplitwiseExpenseShare[];
}

export interface SplitwiseCreateExpenseResponse {
  expense_id: number;
}

export const splitwiseService = {
  async connect(payload: SplitwiseConnectRequest): Promise<SplitwiseConnectResponse> {
    return apiClient.post('/splitwise/connect', payload);
  },

  async oauth2Start(payload: SplitwiseOAuth2StartRequest): Promise<SplitwiseOAuth2StartResponse> {
    return apiClient.post('/splitwise/oauth2/start', payload);
  },

  async me(sessionId: string): Promise<SplitwiseMe> {
    return apiClient.get('/splitwise/me', { session_id: sessionId });
  },

  async groups(sessionId: string): Promise<SplitwiseGroup[]> {
    return apiClient.get('/splitwise/groups', { session_id: sessionId });
  },

  async createExpense(payload: SplitwiseCreateExpenseRequest): Promise<SplitwiseCreateExpenseResponse> {
    return apiClient.post('/splitwise/expense/create', payload);
  },
};

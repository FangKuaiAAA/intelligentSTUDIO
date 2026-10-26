// ============================================================
// renderer/api/types.ts — API 请求/响应类型
// ============================================================

import type { ExternalApiConfig } from '../../shared/types';

export type { ExternalApiConfig };

export interface ExternalApiResponse {
  success: boolean;
  data?: Blob;
  error?: string;
}
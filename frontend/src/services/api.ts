import type {
  AuthSession,
  AuthUser,
  AuditEntry,
  BackendHealth,
  SystemDiagnostic,
  BrandGuideline,
  ContentSubmission,
  ComplianceReport,
  CreateGuidelineDTO,
  CreateSubmissionDTO,
  LoginCredentials,
  RegisterCredentials,
  OnboardCredentials,
  OrganizationMember,
  ReviewDecisionDTO,
  TeamInvitation,
  CreateInvitationDTO,
  InvitationValidationResponse,
  AcceptInvitationDTO,
} from '../types';

// Central API Base URL configured via environment variables with relative fallback
const API_BASE_URL = (
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) ||
  ''
).replace(/\/$/, '');

const TOKEN_STORAGE_KEY = 'brandshield_auth_token';
const USER_STORAGE_KEY = 'brandshield_auth_user';

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getCurrentUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function setAuthSession(session: AuthSession): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, session.access_token);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(session.user));
    window.dispatchEvent(new CustomEvent('auth:session-updated', { detail: session.user }));
  } catch (err) {
    console.error('Failed to save auth session:', err);
  }
}

export function clearAuthSession(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent('auth:session-cleared'));
  } catch (err) {
    console.error('Failed to clear auth session:', err);
  }
}

/**
 * Generic fetch wrapper with timeout, CORS headers, Bearer auth, and structured error extraction.
 */
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs = 6000
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    const token = getAuthToken();
    if (token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 401) {
        clearAuthSession();
      }
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        } else if (errorData.detail) {
          errorMessage = typeof errorData.detail === 'string'
            ? errorData.detail
            : JSON.stringify(errorData.detail);
        }
      } catch {
        // Response was not JSON
      }
      throw new Error(errorMessage);
    }

    return (await response.json()) as T;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }
    throw new Error('An unknown network error occurred.');
  }
}

// ==============================================================================
// 1. Health & Diagnostics
// ==============================================================================

export async function checkBackendHealth(): Promise<BackendHealth> {
  const startTime = performance.now();
  try {
    // Reconcile with /api/v1 prefix while maintaining backward-compatible fallback to /health
    let data: {
      status: string;
      app_name?: string;
      version?: string;
      environment?: string;
      timestamp?: string;
    };
    try {
      data = await apiRequest('/api/v1/health', { method: 'GET' }, 3000);
    } catch {
      data = await apiRequest('/health', { method: 'GET' }, 3000);
    }

    const latency = Math.round(performance.now() - startTime);
    return {
      status: data.status || 'healthy',
      app_name: data.app_name || 'BrandShield AI Backend',
      version: data.version || '0.1.0',
      environment: data.environment || 'development',
      timestamp: data.timestamp,
      latency_ms: latency,
      is_connected: true,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Backend unreachable';
    return {
      status: 'disconnected',
      is_connected: false,
      error_message: message,
    };
  }
}

export async function fetchSystemDiagnostic(): Promise<SystemDiagnostic> {
  return apiRequest<SystemDiagnostic>('/api/v1/system/status', { method: 'GET' });
}

// ==============================================================================
// 2. Brand Guidelines
// ==============================================================================

export async function fetchGuidelines(isActive?: boolean): Promise<BrandGuideline[]> {
  const query = isActive !== undefined ? `?is_active=${isActive}` : '';
  return apiRequest<BrandGuideline[]>(`/api/v1/guidelines${query}`, { method: 'GET' });
}

export async function createGuideline(payload: CreateGuidelineDTO): Promise<BrandGuideline> {
  return apiRequest<BrandGuideline>('/api/v1/guidelines', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateGuideline(
  id: string,
  payload: Partial<CreateGuidelineDTO>
): Promise<BrandGuideline> {
  return apiRequest<BrandGuideline>(`/api/v1/guidelines/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function toggleGuidelineActive(id: string): Promise<BrandGuideline> {
  return apiRequest<BrandGuideline>(`/api/v1/guidelines/${id}/toggle-active`, {
    method: 'PATCH',
  });
}

// ==============================================================================
// 3. Content Submissions
// ==============================================================================

export async function fetchSubmissions(statusFilter?: string): Promise<ContentSubmission[]> {
  const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
  const rawList = await apiRequest<Array<{
    id: string;
    title: string;
    content: string;
    target_channel: string;
    target_audience?: string;
    status: string;
    version: number;
    created_at: string;
    author_id?: string;
    author_name?: string;
    latest_review_id?: string;
  }>>(`/api/v1/submissions${query}`, { method: 'GET' });

  // Map to frontend interface with author label
  return rawList.map((item) => ({
    id: item.id,
    title: item.title,
    content: item.content,
    target_channel: item.target_channel as ContentSubmission['target_channel'],
    target_audience: item.target_audience || 'General Enterprise Audience',
    status: item.status as ContentSubmission['status'],
    version: item.version,
    created_at: item.created_at,
    author_name: item.author_name || 'Unknown author',
    latest_review_id: item.latest_review_id,
    is_demo: false,
  }));
}

export async function fetchSubmission(id: string): Promise<ContentSubmission> {
  const item = await apiRequest<{
    id: string;
    title: string;
    content: string;
    target_channel: string;
    target_audience?: string;
    status: string;
    version: number;
    created_at: string;
    author_id?: string;
    author_name?: string;
    latest_review_id?: string;
  }>(`/api/v1/submissions/${id}`, { method: 'GET' });

  return {
    id: item.id,
    title: item.title,
    content: item.content,
    target_channel: item.target_channel as ContentSubmission['target_channel'],
    target_audience: item.target_audience || 'General Enterprise Audience',
    status: item.status as ContentSubmission['status'],
    version: item.version,
    created_at: item.created_at,
    author_name: item.author_name || 'Unknown author',
    latest_review_id: item.latest_review_id,
    is_demo: false,
  };
}

export async function createSubmission(
  payload: CreateSubmissionDTO,
  submitForInspection = false
): Promise<ContentSubmission> {
  const query = submitForInspection ? '?submit_for_inspection=true' : '';
  const item = await apiRequest<{
    id: string;
    title: string;
    content: string;
    target_channel: string;
    target_audience?: string;
    status: string;
    version: number;
    created_at: string;
    author_id?: string;
    author_name?: string;
    latest_review_id?: string;
  }>(`/api/v1/submissions${query}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return {
    id: item.id,
    title: item.title,
    content: item.content,
    target_channel: item.target_channel as ContentSubmission['target_channel'],
    target_audience: item.target_audience || 'General Enterprise Audience',
    status: item.status as ContentSubmission['status'],
    version: item.version,
    created_at: item.created_at,
    author_name: item.author_name || 'Unknown author',
    latest_review_id: item.latest_review_id,
    is_demo: false,
  };
}

export async function submitDraftForInspection(id: string): Promise<ContentSubmission> {
  const item = await apiRequest<{
    id: string;
    title: string;
    content: string;
    target_channel: string;
    target_audience?: string;
    status: string;
    version: number;
    created_at: string;
    author_id?: string;
    author_name?: string;
    latest_review_id?: string;
  }>(`/api/v1/submissions/${id}/submit`, {
    method: 'POST',
  });

  return {
    id: item.id,
    title: item.title,
    content: item.content,
    target_channel: item.target_channel as ContentSubmission['target_channel'],
    target_audience: item.target_audience || 'General Enterprise Audience',
    status: item.status as ContentSubmission['status'],
    version: item.version,
    created_at: item.created_at,
    author_name: item.author_name || 'Unknown author',
    latest_review_id: item.latest_review_id,
    is_demo: false,
  };
}

// ==============================================================================
// 4. Compliance Reports
// ==============================================================================

export async function fetchSubmissionReport(submissionId: string): Promise<ComplianceReport> {
  return apiRequest<ComplianceReport>(`/api/v1/submissions/${submissionId}/report`, {
    method: 'GET',
  });
}

// ==============================================================================
// 5. Human Review & Authorization
// ==============================================================================

export async function fetchPendingReviews(): Promise<ContentSubmission[]> {
  const rawList = await apiRequest<Array<{
    id: string;
    title: string;
    content: string;
    target_channel: string;
    target_audience?: string;
    status: string;
    version: number;
    created_at: string;
    author_id?: string;
    author_name?: string;
    latest_review_id?: string;
  }>>('/api/v1/reviews/pending', { method: 'GET' });

  return rawList.map((item) => ({
    id: item.id,
    title: item.title,
    content: item.content,
    target_channel: item.target_channel as ContentSubmission['target_channel'],
    target_audience: item.target_audience || 'General Enterprise Audience',
    status: item.status as ContentSubmission['status'],
    version: item.version,
    created_at: item.created_at,
    author_name: item.author_name || 'Unknown author',
    latest_review_id: item.latest_review_id,
    is_demo: false,
  }));
}

export async function recordHumanReview(
  submissionId: string,
  payload: ReviewDecisionDTO
): Promise<{
  success: boolean;
  message: string;
  submission: {
    id: string;
    status: string;
    version: number;
    content: string;
    latest_review_id?: string;
  };
  decision: {
    id: string;
    action: string;
    reviewer_name: string;
    feedback?: string;
    decided_at: string;
  };
  audit_entry_id: string;
}> {
  return apiRequest(`/api/v1/submissions/${submissionId}/review`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ==============================================================================
// 6. Workflow Transitions
// ==============================================================================

export async function analyzeSubmission(submissionId: string): Promise<ContentSubmission> {
  const item = await apiRequest<{
    id: string;
    title: string;
    content: string;
    target_channel: string;
    target_audience?: string;
    status: string;
    version: number;
    created_at: string;
    author_id?: string;
    author_name?: string;
    latest_review_id?: string;
  }>(`/api/v1/submissions/${submissionId}/analyze`, {
    method: 'POST',
  });

  return {
    id: item.id,
    title: item.title,
    content: item.content,
    target_channel: item.target_channel as ContentSubmission['target_channel'],
    target_audience: item.target_audience || 'General Enterprise Audience',
    status: item.status as ContentSubmission['status'],
    version: item.version,
    created_at: item.created_at,
    author_name: item.author_name || 'Unknown author',
    latest_review_id: item.latest_review_id,
    is_demo: false,
  };
}

export async function advanceSubmissionToReview(submissionId: string): Promise<ContentSubmission> {
  const item = await apiRequest<{
    id: string;
    title: string;
    content: string;
    target_channel: string;
    target_audience?: string;
    status: string;
    version: number;
    created_at: string;
    author_id?: string;
    author_name?: string;
    latest_review_id?: string;
  }>(`/api/v1/submissions/${submissionId}/advance-to-review`, {
    method: 'POST',
  });

  return {
    id: item.id,
    title: item.title,
    content: item.content,
    target_channel: item.target_channel as ContentSubmission['target_channel'],
    target_audience: item.target_audience || 'General Enterprise Audience',
    status: item.status as ContentSubmission['status'],
    version: item.version,
    created_at: item.created_at,
    author_name: item.author_name || 'Unknown author',
    latest_review_id: item.latest_review_id,
    is_demo: false,
  };
}

// ==============================================================================
// 7. Authentication & User Management
// ==============================================================================

export async function login(credentials: LoginCredentials): Promise<AuthSession> {
  const session = await apiRequest<AuthSession>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
  setAuthSession(session);
  return session;
}

export async function register(credentials: RegisterCredentials): Promise<AuthSession> {
  const session = await apiRequest<AuthSession>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      full_name: credentials.full_name.trim(),
      email: credentials.email.trim().toLowerCase(),
      password: credentials.password,
    }),
  });
  setAuthSession(session);
  return session;
}

export async function onboardWorkspace(credentials: OnboardCredentials): Promise<AuthSession> {
  const session = await apiRequest<AuthSession>('/api/v1/auth/onboard', {
    method: 'POST',
    body: JSON.stringify({
      organization_name: credentials.organization_name.trim(),
      full_name: credentials.full_name.trim(),
      email: credentials.email.trim().toLowerCase(),
      password: credentials.password,
    }),
  });
  setAuthSession(session);
  return session;
}

export async function logout(): Promise<void> {
  try {
    await apiRequest('/api/v1/auth/logout', { method: 'POST' });
  } catch (err) {
    // Stateless logout: Server-side token blacklist is not maintained.
    // Client-side session and in-memory state discard is the authoritative logout mechanism.
    console.warn('Backend logout request failed or unreachable; discarding local session:', err);
  } finally {
    clearAuthSession();
  }
}

export async function fetchCurrentUser(): Promise<AuthUser> {
  return apiRequest<AuthUser>('/api/v1/auth/me', { method: 'GET' });
}

export function ensureAuthenticatedSession(): string | null {
  // Security Hardening: Never automatically authenticate unauthenticated users.
  // Unauthenticated requests must remain unauthenticated and prompt for explicit sign-in.
  return getAuthToken();
}

// ==============================================================================
// 8. Team Invitations & Member Onboarding
// ==============================================================================

/**
 * Creates a cryptographically signed single-use invitation for a CREATOR or REVIEWER role.
 * Invariant: ADMIN role cannot be invited; only workspace onboarding creates ADMINs.
 */
export async function createInvitation(payload: CreateInvitationDTO): Promise<TeamInvitation> {
  return apiRequest<TeamInvitation>('/api/v1/invitations', {
    method: 'POST',
    body: JSON.stringify({
      email: payload.email.trim().toLowerCase(),
      role: payload.role,
    }),
  });
}

/**
 * Retrieves all invitations associated with the administrator's organization,
 * including active PENDING, ACCEPTED, REVOKED, and EXPIRED invitations.
 */
export async function listInvitations(): Promise<TeamInvitation[]> {
  return apiRequest<TeamInvitation[]>('/api/v1/invitations', {
    method: 'GET',
  });
}

/**
 * Revokes an active PENDING invitation.
 */
export async function revokeInvitation(invitationId: string): Promise<TeamInvitation> {
  return apiRequest<TeamInvitation>(`/api/v1/invitations/${invitationId}`, {
    method: 'DELETE',
  });
}

/**
 * Validates a single-use invitation token against the public validation endpoint.
 * Returns organization metadata and assigned role if valid.
 */
export async function validateInvitationToken(token: string): Promise<InvitationValidationResponse> {
  const cleanToken = encodeURIComponent(token.trim());
  return apiRequest<InvitationValidationResponse>(`/api/v1/invitations/validate?token=${cleanToken}`, {
    method: 'GET',
  });
}

/**
 * Accepts an invitation with user-provided credentials, atomically provisioning
 * the account within the target organization and returning an active AuthSession.
 */
export async function acceptInvitation(payload: AcceptInvitationDTO): Promise<AuthSession> {
  const session = await apiRequest<AuthSession>('/api/v1/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({
      token: payload.token.trim(),
      full_name: payload.full_name.trim(),
      password: payload.password,
    }),
  });
  setAuthSession(session);
  return session;
}

/**
 * Retrieves all registered, active members in the administrator's organization,
 * including the organization owner and role assignments.
 */
export async function fetchOrganizationMembers(): Promise<OrganizationMember[]> {
  return apiRequest<OrganizationMember[]>('/api/v1/invitations/members', {
    method: 'GET',
  });
}

/**
 * Retrieves recent immutable audit trail records for the organization.
 */
export async function fetchAuditLogs(limit = 20): Promise<AuditEntry[]> {
  const items = await apiRequest<any[]>(`/api/v1/submissions/audit-trail?limit=${limit}`, {
    method: 'GET',
  });
  return items.map((item) => ({
    id: item.id,
    organization_name: item.organization_name || 'Organization',
    submission_id: item.submission_id,
    previous_status: item.previous_status,
    new_status: item.new_status,
    action_type: item.action_type,
    actor_id: item.actor_id,
    actor_type: item.actor_type,
    actor_name: item.actor_name,
    notes: item.notes || undefined,
    timestamp: item.timestamp,
  }));
}


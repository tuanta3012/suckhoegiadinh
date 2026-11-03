import { UserRole, WorkspaceMember } from '../types';

/**
 * Hàm chuẩn hóa và xác định chính xác vai trò (Role) của người dùng:
 * - Nếu là email chủ tài khoản (tuanta3012@gmail.com hoặc workspaceOwnerEmail) -> Luôn là ADMIN.
 * - Nếu có trong danh sách thành viên (members) -> Lấy đúng vai trò được phân quyền.
 * - Luôn trả về chữ in hoa chuẩn: 'ADMIN' | 'EDITOR' | 'VIEWER'.
 */
export function resolveUserRole(
  userEmail?: string | null,
  currentRole?: string | null,
  members?: WorkspaceMember[] | null,
  workspaceOwnerEmail?: string | null
): UserRole {
  if (!userEmail) return 'ADMIN';
  const cleanEmail = userEmail.trim().toLowerCase();

  // 1. Nếu là email chủ sở hữu Workspace (workspaceOwnerEmail) -> Luôn là ADMIN
  if (workspaceOwnerEmail && cleanEmail === workspaceOwnerEmail.trim().toLowerCase()) {
    return 'ADMIN';
  }

  // 2. Tra cứu trong danh sách thành viên được phân quyền
  if (members && Array.isArray(members) && members.length > 0) {
    const matched = members.find((m) => m.email && m.email.trim().toLowerCase() === cleanEmail);
    if (matched && matched.role) {
      return matched.role.toUpperCase() as UserRole;
    }
    // Nếu có danh sách members nhưng user không thuộc danh sách -> VIEWER
    return 'VIEWER';
  }

  // 3. Nếu chưa có danh sách thành viên (file riêng tư cá nhân) -> ADMIN
  if (currentRole) {
    const upper = currentRole.toUpperCase();
    if (upper === 'ADMIN' || upper === 'EDITOR' || upper === 'VIEWER') {
      return upper as UserRole;
    }
  }

  return 'ADMIN';
}

import { UserRole, WorkspaceMember } from '../types';

/**
 * Hàm chuẩn hóa và xác định chính xác vai trò (Role) của người dùng:
 * - Nếu là email chủ tài khoản (workspaceOwnerEmail) -> Luôn là Owner.
 * - Nếu có trong danh sách thành viên (members) -> Lấy đúng vai trò được phân quyền.
 * - Luôn trả về chữ chuẩn: 'Owner' | 'Editor' | 'Viewer'.
 */
export function resolveUserRole(
  userEmail?: string | null,
  currentRole?: string | null,
  members?: WorkspaceMember[] | null,
  workspaceOwnerEmail?: string | null
): UserRole {
  if (!userEmail) return 'Owner';
  const cleanEmail = userEmail.trim().toLowerCase();

  // 1. Nếu là email chủ sở hữu Workspace (workspaceOwnerEmail) -> Luôn là Owner
  if (workspaceOwnerEmail && cleanEmail === workspaceOwnerEmail.trim().toLowerCase()) {
    return 'Owner';
  }

  // 2. Tra cứu trong danh sách thành viên được phân quyền
  if (members && Array.isArray(members) && members.length > 0) {
    const matched = members.find((m) => m.email && m.email.trim().toLowerCase() === cleanEmail);
    if (matched && matched.role) {
      const r = matched.role.toLowerCase();
      if (r === 'owner' || r === 'admin') return 'Owner';
      if (r === 'editor') return 'Editor';
      return 'Viewer';
    }
    // Nếu có danh sách members nhưng user không thuộc danh sách -> Viewer
    return 'Viewer';
  }

  // 3. Nếu chưa có danh sách thành viên (file riêng tư cá nhân) -> Owner
  if (currentRole) {
    const r = currentRole.toLowerCase();
    if (r === 'owner' || r === 'admin') return 'Owner';
    if (r === 'editor') return 'Editor';
    if (r === 'viewer') return 'Viewer';
  }

  return 'Owner';
}

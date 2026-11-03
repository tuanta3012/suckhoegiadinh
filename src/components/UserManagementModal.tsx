import React, { useState } from 'react';
import {
  X,
  Users,
  UserPlus,
  ShieldAlert,
  Trash2,
  CheckCircle2,
  Edit3,
  Eye,
  LogOut,
  Mail,
  UserCheck,
  CloudOff,
  FolderSync,
} from 'lucide-react';
import { AppSettings, AuthUser, WorkspaceMember, UserRole, canManageMembers } from '../types';
import { useConfirmDialog } from '../context/ConfirmDialogContext';
import { DrivePermissionSyncResult } from '../utils/googleDriveService';
import { resolveUserRole } from '../utils/roleHelper';

interface UserManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AuthUser | null;
  settings: AppSettings;
  onSaveMembers: (updatedMembers: WorkspaceMember[]) => Promise<DrivePermissionSyncResult | null>;
  onResyncDrivePermissions: () => Promise<DrivePermissionSyncResult>;
  onLeaveWorkspace?: () => void;
  onOpenSyncModal?: () => void;
}

export const UserManagementModal: React.FC<UserManagementModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  settings,
  onSaveMembers,
  onResyncDrivePermissions,
  onLeaveWorkspace,
  onOpenSyncModal,
}) => {
  const { confirm } = useConfirmDialog();
  if (!isOpen) return null;

  const userEmail = currentUser?.email?.trim().toLowerCase();
  const ownerEmail = settings.workspaceOwnerEmail?.trim().toLowerCase();
  const isOwner = Boolean(userEmail && ownerEmail && userEmail === ownerEmail);
  const currentRole: UserRole = isOwner
    ? 'ADMIN'
    : resolveUserRole(
        userEmail,
        settings.currentRole,
        settings.members,
        settings.workspaceOwnerEmail
      );
  const isAdmin = canManageMembers(currentRole);

  const [members, setMembers] = useState<WorkspaceMember[]>(() => {
    if (settings.members && settings.members.length > 0) {
      return settings.members;
    }
    if (currentUser?.email) {
      return [
        {
          id: 'owner-1',
          email: currentUser.email.toLowerCase(),
          name: currentUser.name || 'Admin',
          role: 'ADMIN',
          addedAt: new Date().toISOString(),
        },
      ];
    }
    return [];
  });

  React.useEffect(() => {
    if (settings.members && settings.members.length > 0) {
      setMembers((prev) => {
        const prevStr = JSON.stringify(prev);
        const nextStr = JSON.stringify(settings.members);
        return prevStr === nextStr ? prev : (settings.members || prev);
      });
    }
  }, [settings.members]);

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('VIEWER');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const hasLinkedDriveFile = Boolean(settings.googleSheetUrl && settings.googleSheetUrl.trim().length > 0);

  React.useEffect(() => {
    if (isOpen && hasLinkedDriveFile && isAdmin) {
      const runBackgroundSync = async () => {
        try {
          await onResyncDrivePermissions();
        } catch (err) {
          console.log('Background drive permission sync note:', err);
        }
      };
      runBackgroundSync();
    }
  }, [isOpen]);

  const showPermissionSyncResult = (result: DrivePermissionSyncResult | null) => {
    if (!result) {
      setSuccessMsg('Đã lưu danh sách trên thiết bị; chưa có phiên Google để đồng bộ quyền Drive.');
      return;
    }
    const failures = result.entries.filter((entry) => entry.action === 'failed');
    if (failures.length) {
      setErrorMsg(
        `Roster đã lưu trên Drive nhưng ${failures.length} quyền chưa đồng bộ. ${failures
          .slice(0, 3)
          .map((entry) => `${entry.email}: ${entry.message}`)
          .join(' ')}`
      );
      return;
    }
    setSuccessMsg('Đã lưu thành viên và xác nhận đồng bộ quyền Drive.');
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasLinkedDriveFile) {
      setErrorMsg('Vui lòng kết nối hoặc tạo file Google Drive trước khi thêm thành viên.');
      return;
    }
    if (!newName.trim() || !newEmail.trim()) {
      setErrorMsg('Vui lòng nhập tên và Gmail thành viên.');
      return;
    }

    const emailInput = newEmail.trim().toLowerCase();
    const cleanEmail = emailInput.includes('@') ? emailInput : `${emailInput}@gmail.com`;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setErrorMsg('Địa chỉ Gmail không hợp lệ.');
      return;
    }

    if (members.some((m) => m.email.toLowerCase() === cleanEmail)) {
      setErrorMsg('Email đã tồn tại trong danh sách.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const newMember: WorkspaceMember = {
      id: `member-${Date.now()}`,
      email: cleanEmail,
      name: newName.trim(),
      role: newRole,
      addedAt: new Date().toISOString(),
      addedBy: currentUser?.email || 'Admin',
    };

    const updated = [...members, newMember];
    try {
      const result = await onSaveMembers(updated);
      setMembers(updated);
      setNewName('');
      setNewEmail('');
      showPermissionSyncResult(result);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Lỗi khi lưu thành viên.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRoleChange = async (memberId: string, targetRole: UserRole) => {
    setErrorMsg(null);
    setSuccessMsg(null);

    const updated = members.map((m) => (m.id === memberId ? { ...m, role: targetRole } : m));

    setIsSubmitting(true);
    try {
      setMembers(updated);
      const result = await onSaveMembers(updated);
      showPermissionSyncResult(result);
      setTimeout(() => setSuccessMsg(null), 2500);
    } catch (err) {
      setMembers(members);
      setErrorMsg(err instanceof Error ? err.message : 'Không thể cập nhật quyền.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveMember = async (memberId: string, memberEmail: string) => {
    if (!(await confirm({
      title: 'Thu hồi quyền truy cập?',
      message: memberEmail,
      confirmLabel: 'Thu hồi',
    }))) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    const updated = members.filter((m) => m.id !== memberId);
    setIsSubmitting(true);
    try {
      setMembers(updated);
      const result = await onSaveMembers(updated);
      if (!result || result.entries.some((entry) => entry.action === 'failed')) {
        showPermissionSyncResult(result);
      }
    } catch (err) {
      setMembers(members);
      setErrorMsg(err instanceof Error ? err.message : 'Lỗi khi xóa thành viên.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4 bg-slate-900/70 backdrop-blur-xs overflow-y-auto">
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
        
        {/* Compact Header */}
        <div className="bg-slate-900 text-white p-3 sm:p-3.5 flex items-center justify-between border-b border-slate-800 pr-10 relative">
          <div className="flex items-center gap-2 min-w-0">
            <Users className="w-5 h-5 text-emerald-400 shrink-0" />
            <h2 className="text-sm sm:text-base font-bold tracking-tight text-white truncate">
              Quản lý thành viên
            </h2>
          </div>

          <button
            onClick={onClose}
            className="absolute top-2.5 right-2.5 p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
            title="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Scroll Content */}
        <div className="p-3 sm:p-4 space-y-3.5 max-h-[82vh] overflow-y-auto text-slate-800">
          
          {/* Feedback messages */}
          {successMsg && (
            <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs flex items-center gap-1.5 animate-in fade-in">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {errorMsg && (
            <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs flex items-center gap-1.5 animate-in fade-in">
              <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}


          {/* Form Thêm Thành Viên (Dành cho ADMIN) */}
          {!hasLinkedDriveFile ? (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-2 text-xs">
              <div className="flex items-center gap-1.5 font-bold text-amber-900">
                <CloudOff className="w-4 h-4 text-amber-600 shrink-0" />
                <span>Chưa liên kết file Google Drive</span>
              </div>
              <p className="text-amber-800 leading-relaxed text-[11px]">
                Ứng dụng chưa kết nối với file Google Sheet nào trên Google Drive. Để thêm và cấp quyền cho các thành viên gia đình, bạn cần kết nối hoặc tạo mới một file Google Sheet trước.
              </p>
              {onOpenSyncModal && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenSyncModal();
                  }}
                  className="w-full py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center space-x-1.5 transition-all cursor-pointer shadow-xs"
                >
                  <FolderSync className="w-4 h-4" />
                  <span>Kết nối hoặc Tạo file Google Drive ngay</span>
                </button>
              )}
            </div>
          ) : isAdmin ? (
            <form onSubmit={handleAddMember} className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
              <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5 text-emerald-600" />
                <span>Thêm thành viên mới</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <input
                    type="text"
                    placeholder="Tên (Ví dụ: Vợ, Con...)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                    required
                  />
                </div>

                <div className="relative">
                  <Mail className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    inputMode="email"
                    autoCapitalize="none"
                    placeholder="username@gmail.com hoặc username"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                    required
                  />
                </div>
              </div>

              {/* Roles Compact Pill Selector */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setNewRole('VIEWER')}
                  className={`py-1.5 px-2 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all whitespace-nowrap ${
                    newRole === 'VIEWER'
                      ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5 shrink-0" />
                  <span>👁️ Chỉ xem</span>
                </button>

                <button
                  type="button"
                  onClick={() => setNewRole('EDITOR')}
                  className={`py-1.5 px-2 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all whitespace-nowrap ${
                    newRole === 'EDITOR'
                      ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5 shrink-0" />
                  <span>✏️ Được sửa</span>
                </button>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-xs shadow-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>{isSubmitting ? 'Đang lưu...' : 'Thêm & Cấp quyền'}</span>
              </button>
            </form>
          ) : (
            <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-xs">
              Bạn ở vai trò <strong>{currentRole === 'EDITOR' ? 'Quyền sửa' : 'Chỉ xem'}</strong>. Chỉ tài khoản <strong>Admin</strong> mới có quyền thêm/chỉnh thành viên.
            </div>
          )}

          {/* Members List */}
          <div>
            <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-2">
              <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
              <span>Thành viên ({members.length})</span>
            </div>

            <div className="space-y-1.5">
              {members.length === 0 ? (
                <div className="text-center py-4 text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                  Chưa có thành viên nào.
                </div>
              ) : (
                members.map((member) => {
                  const isSelf = currentUser?.email && member.email.toLowerCase() === currentUser.email.toLowerCase();
                  const isOwner = member.role === 'ADMIN';

                  return (
                    <div
                      key={member.id}
                      className="p-2 sm:p-2.5 bg-white border border-slate-200 rounded-xl flex items-center justify-between gap-2 shadow-2xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                            member.role === 'ADMIN'
                              ? 'bg-amber-100 text-amber-800 border border-amber-300'
                              : member.role === 'EDITOR'
                              ? 'bg-blue-100 text-blue-800 border border-blue-300'
                              : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          }`}
                        >
                          {member.name ? member.name.charAt(0).toUpperCase() : 'U'}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1">
                            <span className="text-xs font-bold text-slate-800 truncate max-w-[100px] sm:max-w-[130px]">
                              {member.name}
                            </span>
                            {isSelf && (
                              <span className="text-[9px] bg-slate-100 text-slate-600 px-1 py-0.2 rounded font-semibold shrink-0">
                                Bạn
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate max-w-[130px] sm:max-w-[160px]">
                            {member.email}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isAdmin && !isOwner ? (
                          <div className="flex items-center gap-1">
                            <select
                              value={member.role}
                              onChange={(e) => handleRoleChange(member.id, e.target.value as UserRole)}
                              disabled={isSubmitting}
                              className="text-[11px] py-1 px-1.5 bg-slate-100 border border-slate-200 rounded-md font-semibold text-slate-700 outline-none"
                            >
                              <option value="VIEWER">👁️ Xem</option>
                              <option value="EDITOR">✏️ Sửa</option>
                              <option value="ADMIN">👑 Admin</option>
                            </select>

                            <button
                              type="button"
                              onClick={() => handleRemoveMember(member.id, member.email)}
                              disabled={isSubmitting}
                              className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                              title="Thu hồi quyền"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              member.role === 'ADMIN'
                                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                : member.role === 'EDITOR'
                                ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            }`}
                          >
                            {member.role === 'ADMIN' ? '👑 Admin' : member.role === 'EDITOR' ? '✏️ Sửa' : '👁️ Xem'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Autonomy / Leave Workspace Option */}
          {onLeaveWorkspace && currentRole !== 'ADMIN' && (
            <div className="pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={async () => {
                  if (await confirm({
                    title: 'Rời nhóm?',
                    message: 'Bạn sẽ rời khỏi nhóm và chuyển sang không gian cá nhân.',
                    confirmLabel: 'Rời nhóm',
                  })) {
                    onLeaveWorkspace();
                    onClose();
                  }
                }}
                className="w-full py-1.5 px-2 bg-slate-100 hover:bg-rose-50 text-slate-600 hover:text-rose-700 border border-slate-200 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Rời nhóm</span>
              </button>
            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="p-2.5 bg-slate-50 border-t border-slate-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-900 transition-colors"
          >
            Đóng
          </button>
        </div>

      </div>
    </div>
  );
};

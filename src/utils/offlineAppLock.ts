import { NativeBiometric } from '@capgo/capacitor-native-biometric';

export async function verifyDeviceUnlock(): Promise<void> {
  const availability = await NativeBiometric.isAvailable({ useFallback: true });
  if (!availability.isAvailable) {
    throw new Error('Thiết bị chưa bật vân tay hoặc mã khóa màn hình. Hãy đăng nhập Google để xem dữ liệu.');
  }
  await NativeBiometric.verifyIdentity({
    title: 'Mở dữ liệu ngoại tuyến',
    subtitle: 'Xác minh danh tính để xem dữ liệu sức khỏe đã lưu',
    description: 'Dùng vân tay hoặc mã khóa màn hình của thiết bị.',
    reason: 'Bảo vệ dữ liệu sức khỏe ngoại tuyến',
    useFallback: true,
    fallbackTitle: 'Dùng mã khóa thiết bị',
    maxAttempts: 3,
  });
}

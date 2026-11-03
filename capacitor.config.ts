import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tietkiemgiadinh.app',
  appName: 'Tiết Kiệm Gia Đình',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_savings',
      iconColor: '#10b981',
      sound: 'beep.wav',
    },
    GoogleAuth: {
      scopes: [
        'profile',
        'email',
        'openid',
        'https://www.googleapis.com/auth/drive.file',
      ],
      clientId: '864440372329-fgoo89lqp196nvcptmfc7pquofuj8agt.apps.googleusercontent.com',
      serverClientId: '864440372329-fgoo89lqp196nvcptmfc7pquofuj8agt.apps.googleusercontent.com',
      forceCodeForRefreshToken: false,
    },
  },
};

export default config;

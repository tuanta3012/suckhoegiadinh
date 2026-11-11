import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.suckhoegiadinh.app',
  appName: 'Sức khỏe gia đình',
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
      clientId: '637661729068-un1n9pu5rcul04domu1113fguun9poni.apps.googleusercontent.com',
      serverClientId: '637661729068-un1n9pu5rcul04domu1113fguun9poni.apps.googleusercontent.com',
      forceCodeForRefreshToken: false,
    },
  },
};

export default config;

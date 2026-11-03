import React from 'react';
import { useFamilyMember } from '../context/FamilyMemberContext';

export const HealthDashboard = () => {
  const { selectedMember } = useFamilyMember();

  return (
    <div className="p-4 space-y-6 bg-gray-50 min-h-screen">
      {/* AI Alert Banner */}
      <div className="bg-orange-100 border-l-4 border-orange-500 p-4 rounded-r-lg">
        <p className="text-orange-800 font-medium">
          {selectedMember?.name} cần lưu ý: Acid Uric tăng cao 933.88 µmol/L.
        </p>
      </div>

      {/* Biometric Cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
          <p className="text-gray-500 text-sm">Acid Uric</p>
          <p className="text-2xl font-bold text-red-500">933.88</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
          <p className="text-gray-500 text-sm">Glucose</p>
          <p className="text-2xl font-bold text-medical-green">5.6</p>
        </div>
      </div>
    </div>
  );
};

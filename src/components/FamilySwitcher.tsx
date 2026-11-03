import React from 'react';
import { useFamilyMember } from '../context/FamilyMemberContext';

export const FamilySwitcher = () => {
  const { members, selectedMember, setSelectedMember } = useFamilyMember();

  return (
    <div className="bg-navy p-4 flex gap-4 overflow-x-auto safe-area-header border-b border-navy-800">
      {members.map((member) => (
        <button
          key={member.id}
          onClick={() => setSelectedMember(member)}
          className={`flex flex-col items-center gap-1 transition-all ${
            selectedMember?.id === member.id ? 'opacity-100' : 'opacity-50'
          }`}
        >
          <div className={`w-12 h-12 rounded-full border-2 ${
            selectedMember?.id === member.id ? 'border-medical-green' : 'border-transparent'
          } bg-white flex items-center justify-center text-navy font-bold`}>
            {member.name.charAt(0)}
          </div>
          <span className="text-white text-xs">{member.name}</span>
        </button>
      ))}
    </div>
  );
};

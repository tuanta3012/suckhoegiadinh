import React, { createContext, useContext, useState, ReactNode } from 'react';

export interface FamilyMember {
  id: string;
  name: string;
  avatarUrl?: string;
}

interface FamilyMemberContextType {
  selectedMember: FamilyMember | null;
  setSelectedMember: (member: FamilyMember) => void;
  members: FamilyMember[];
}

const FamilyMemberContext = createContext<FamilyMemberContextType | undefined>(undefined);

export const FamilyMemberProvider = ({ children }: { children: ReactNode }) => {
  // Mock data for now, will connect to Firestore later
  const [members] = useState<FamilyMember[]>([
    { id: '1', name: 'Tuấn', avatarUrl: '' },
    { id: '2', name: 'Lan', avatarUrl: '' },
  ]);
  const [selectedMember, setSelectedMember] = useState<FamilyMember>(members[0]);

  return (
    <FamilyMemberContext.Provider value={{ selectedMember, setSelectedMember, members }}>
      {children}
    </FamilyMemberContext.Provider>
  );
};

export const useFamilyMember = () => {
  const context = useContext(FamilyMemberContext);
  if (!context) {
    throw new Error('useFamilyMember must be used within a FamilyMemberProvider');
  }
  return context;
};

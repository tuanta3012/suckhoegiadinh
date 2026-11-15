import { useMemo, useState } from 'react';
import { LockKeyhole, LogIn } from 'lucide-react';
import type { HealthEvent } from '../types';
import { loadNativeOfflineState } from '../utils/offlineWorkspaceCache';

interface OfflineCachedViewProps {
  email: string;
  onLock: () => void;
  onSignIn: () => void;
}

export function OfflineCachedView({ email, onLock, onSignIn }: OfflineCachedViewProps) {
  const cached = useMemo(() => loadNativeOfflineState(email), [email]);
  const members = cached.workspace.family.members;
  const [selectedMemberId, setSelectedMemberId] = useState(members[0]?.id || '');
  const selectedMember = members.find((member) => member.id === selectedMemberId) || members[0];
  const profile = selectedMember ? cached.profiles[selectedMember.id] : undefined;
  const timeline = [...(profile?.timeline || [])].sort((a, b) =>
    (b.date || b.recordedAt).localeCompare(a.date || a.recordedAt),
  );

  return (
    <main className="h-[100dvh] overflow-y-auto bg-slate-50 px-4 py-6 safe-area-bottom">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="flex items-start justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div>
            <p className="text-sm font-extrabold text-amber-950">Chế độ ngoại tuyến · Chỉ xem</p>
            <p className="mt-1 break-all text-xs text-amber-800">{email}</p>
            <p className="mt-2 text-xs text-amber-800">
              Đây là dữ liệu đã lưu trên thiết bị. Đăng nhập để đồng bộ hoặc chỉnh sửa.
            </p>
          </div>
          <button
            type="button"
            onClick={onLock}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-900"
          >
            <LockKeyhole className="h-4 w-4" aria-hidden="true" />
            Khóa
          </button>
        </header>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h1 className="text-base font-extrabold text-slate-900">Hồ sơ đã lưu trên máy</h1>
            <button
              type="button"
              onClick={onSignIn}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Đăng nhập để sửa
            </button>
          </div>
          {members.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Thiết bị chưa có bản sao hồ sơ ngoại tuyến.
            </p>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {members.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => setSelectedMemberId(member.id)}
                  aria-pressed={member.id === selectedMember?.id}
                  className={`shrink-0 rounded-xl border px-3 py-2 text-sm font-semibold ${
                    member.id === selectedMember?.id
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 bg-white text-slate-600'
                  }`}
                >
                  {member.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedMember && (
          <section className="space-y-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="font-bold text-slate-900">{selectedMember.name}</h2>
              {profile?.summary?.latestDiagnoses?.length ? (
                <div className="mt-3">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Chẩn đoán gần đây</h3>
                  <ul className="mt-2 space-y-1 text-sm text-slate-700">
                    {profile.summary.latestDiagnoses.map((diagnosis, index) => (
                      <li key={`${diagnosis}-${index}`}>{diagnosis}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {profile?.summary?.latestMetrics && Object.keys(profile.summary.latestMetrics).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(profile.summary.latestMetrics).map(([name, value]) => (
                    <span key={name} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-700">
                      {name}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h2 className="px-1 text-sm font-bold text-slate-700">
                Dòng thời gian · {timeline.length} sự kiện
              </h2>
              {timeline.map((event: HealthEvent) => (
                <article key={event.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-bold text-slate-900">{event.title || 'Sự kiện y tế'}</h3>
                    <time className="shrink-0 text-xs tabular-nums text-slate-500">
                      {event.date || event.recordedAt.slice(0, 10)}
                    </time>
                  </div>
                  {event.facility && <p className="mt-1 text-xs text-slate-500">{event.facility}</p>}
                  {event.doctorName && <p className="mt-1 text-xs text-slate-500">Bác sĩ: {event.doctorName}</p>}
                  {event.diagnoses?.length > 0 && (
                    <p className="mt-2 text-sm text-slate-700">{event.diagnoses.join(' · ')}</p>
                  )}
                  {event.metrics?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {event.metrics.map((metric, index) => (
                        <span key={`${metric.name}-${index}`} className="rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600">
                          {metric.name}: {metric.value} {metric.unit}
                        </span>
                      ))}
                    </div>
                  )}
                  {event.physicalExam && (
                    <p className="mt-2 text-xs text-slate-600">
                      Khám: {[
                        event.physicalExam.height_cm && `Cao ${event.physicalExam.height_cm} cm`,
                        event.physicalExam.weight_kg && `Nặng ${event.physicalExam.weight_kg} kg`,
                        event.physicalExam.bmi && `BMI ${event.physicalExam.bmi}`,
                        event.physicalExam.bp_mmHg && `Huyết áp ${event.physicalExam.bp_mmHg}`,
                        event.physicalExam.pulse_bpm && `Mạch ${event.physicalExam.pulse_bpm}/phút`,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {event.medications?.length > 0 && (
                    <div className="mt-3">
                      <h4 className="text-xs font-bold text-slate-600">Thuốc</h4>
                      <ul className="mt-1 space-y-1 text-xs text-slate-600">
                        {event.medications.map((medicine, index) => (
                          <li key={`${medicine.name}-${index}`}>
                            <span className="font-semibold">{medicine.name}</span>
                            {[medicine.dosage, medicine.frequency, medicine.duration, medicine.instructions]
                              .filter(Boolean).join(' · ') && (
                              <span> — {[medicine.dosage, medicine.frequency, medicine.duration, medicine.instructions]
                                .filter(Boolean).join(' · ')}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {event.imagingResults?.map((result, index) => (
                    <div key={`${result.modality}-${index}`} className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                      <p className="font-semibold">{result.modality || 'Chẩn đoán hình ảnh'}</p>
                      {result.findings && <p className="mt-1 whitespace-pre-wrap">{result.findings}</p>}
                      {result.conclusion && <p className="mt-1 font-semibold">Kết luận: {result.conclusion}</p>}
                    </div>
                  ))}
                  {event.vaccinations?.map((vaccination, index) => (
                    <p key={`${vaccination.vaccineName}-${index}`} className="mt-2 text-xs text-slate-600">
                      Tiêm chủng: {vaccination.vaccineName}
                      {vaccination.administeredDate && ` · ${vaccination.administeredDate}`}
                      {vaccination.nextDoseDate && ` · Mũi tiếp theo ${vaccination.nextDoseDate}`}
                    </p>
                  ))}
                  {event.hospitalization && (
                    <div className="mt-2 text-xs text-slate-600">
                      <p className="font-semibold">Thông tin nằm viện</p>
                      {event.hospitalization.department && <p>Khoa: {event.hospitalization.department}</p>}
                      {event.hospitalization.admissionDate && <p>Nhập viện: {event.hospitalization.admissionDate}</p>}
                      {event.hospitalization.dischargeDate && <p>Ra viện: {event.hospitalization.dischargeDate}</p>}
                      {event.hospitalization.treatmentSummary && <p>{event.hospitalization.treatmentSummary}</p>}
                    </div>
                  )}
                  {event.advice && <p className="mt-2 whitespace-pre-wrap text-xs text-slate-600">Dặn dò: {event.advice}</p>}
                  {event.nextFollowUp && <p className="mt-1 text-xs text-slate-600">Tái khám: {event.nextFollowUp}</p>}
                  {event.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{event.notes}</p>}
                </article>
              ))}
              {timeline.length === 0 && (
                <p className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
                  Hồ sơ này chưa có sự kiện trong bản cache.
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

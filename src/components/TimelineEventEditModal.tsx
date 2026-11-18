import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { HealthEvent, HealthMetric, Medication } from '../types';
import { BackPriority, useBackHandler } from '../utils/backNavigation';
import { sanitizeMetricName, standardizeMetricKey } from '../utils/healthRecordService';

interface EventTypeOption {
  value: HealthEvent['type'];
  label: string;
}

interface TimelineEventEditModalProps {
  event: HealthEvent;
  eventTypeOptions: readonly EventTypeOption[];
  isSaving: boolean;
  onClose: () => void;
  onSave: (updatedEvent: HealthEvent) => void;
}

interface EditableMetricRow {
  name: string;
  value: string;
  unit: string;
  refRange: string;
}

interface EditableMedicationRow {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  quantity: string;
  timing: string;
  instructions: string;
}

function toIsoDateValue(value?: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

export function TimelineEventEditModal({
  event,
  eventTypeOptions,
  isSaving,
  onClose,
  onSave,
}: TimelineEventEditModalProps) {
  const [title, setTitle] = useState(event.title || '');
  const [date, setDate] = useState(toIsoDateValue(event.date));
  const [type, setType] = useState<HealthEvent['type']>(event.type);
  const [facility, setFacility] = useState(event.facility || '');
  const [doctorName, setDoctorName] = useState(event.doctorName || '');
  const [diagnoses, setDiagnoses] = useState<string[]>(
    event.diagnoses && event.diagnoses.length > 0 ? [...event.diagnoses] : [],
  );
  const [medications, setMedications] = useState<EditableMedicationRow[]>(
    (event.medications || []).map((med) => ({
      name: med.name || '',
      dosage: med.dosage || '',
      frequency: med.frequency || '',
      duration: med.duration || '',
      quantity: med.quantity || '',
      timing: med.timing || '',
      instructions: med.instructions || '',
    })),
  );
  const [metrics, setMetrics] = useState<EditableMetricRow[]>(
    (event.metrics || []).map((met) => ({
      name: met.name || '',
      value: met.value !== undefined && met.value !== null ? String(met.value) : '',
      unit: met.unit || '',
      refRange: met.refRange || '',
    })),
  );
  const [advice, setAdvice] = useState(event.advice || '');
  const [nextFollowUp, setNextFollowUp] = useState(toIsoDateValue(event.nextFollowUp));
  const [notes, setNotes] = useState(event.notes || '');

  useBackHandler(
    true,
    () => {
      if (!isSaving) onClose();
      return true;
    },
    BackPriority.TOP_MODAL,
  );

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || isSaving) return;

    const sourceMetricByIdentity = new Map<string, HealthMetric>();
    for (const src of event.metrics || []) {
      if (!src?.name) continue;
      const stdKey = standardizeMetricKey(src.standardKey || src.name, src.unit || '', src.name);
      if (stdKey) sourceMetricByIdentity.set(stdKey, src);
      sourceMetricByIdentity.set(sanitizeMetricName(src.name).toLowerCase(), src);
    }

    const nextDiagnoses = diagnoses.map((item) => item.trim()).filter(Boolean);

    const nextMedications: Medication[] = medications
      .filter((row) => row.name.trim())
      .map((row) => ({
        name: row.name.trim(),
        ...(row.dosage.trim() ? { dosage: row.dosage.trim() } : {}),
        ...(row.frequency.trim() ? { frequency: row.frequency.trim() } : {}),
        ...(row.duration.trim() ? { duration: row.duration.trim() } : {}),
        ...(row.quantity.trim() ? { quantity: row.quantity.trim() } : {}),
        ...(row.timing.trim() ? { timing: row.timing.trim() } : {}),
        ...(row.instructions.trim() ? { instructions: row.instructions.trim() } : {}),
      }));

    const nextMetrics: HealthMetric[] = metrics
      .filter((row) => row.name.trim() && row.value.trim())
      .map((row) => {
        const cleanedName = sanitizeMetricName(row.name.trim()) || row.name.trim();
        const trimmedUnit = row.unit.trim();
        const rawVal = row.value.trim();
        const numericCandidate = rawVal.replace(',', '.');
        const parsedNum = Number(numericCandidate);
        const metricValue: number | string = Number.isFinite(parsedNum) ? parsedNum : rawVal;
        const matchedSource =
          sourceMetricByIdentity.get(standardizeMetricKey(cleanedName, trimmedUnit, cleanedName)) ||
          sourceMetricByIdentity.get(cleanedName.toLowerCase());
        const resolvedUnit = trimmedUnit || matchedSource?.unit || '';
        const resolvedRef = row.refRange.trim() || matchedSource?.refRange;
        return {
          name: cleanedName,
          ...(matchedSource?.standardKey ? { standardKey: matchedSource.standardKey } : {}),
          value: metricValue,
          unit: resolvedUnit,
          ...(resolvedRef ? { refRange: resolvedRef } : {}),
          ...(matchedSource?.status && String(metricValue) === String(matchedSource.value)
            ? { status: matchedSource.status }
            : {}),
        };
      });

    onSave({
      ...event,
      title: trimmedTitle,
      date: date.trim(),
      type,
      facility: facility.trim() || undefined,
      doctorName: doctorName.trim() || undefined,
      diagnoses: nextDiagnoses,
      medications: nextMedications,
      metrics: nextMetrics,
      advice: advice.trim() || undefined,
      nextFollowUp: nextFollowUp.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-3 overflow-y-auto animate-in fade-in"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isSaving) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-label="Chỉnh sửa sự kiện y tế"
        className="my-auto w-full max-w-lg max-h-[90vh] overflow-y-auto overflow-x-hidden rounded-3xl bg-white p-4 sm:p-5 shadow-2xl space-y-3 text-xs"
      >
        <div className="space-y-3 min-w-0">
          <label className="block font-bold text-slate-700">
            Tiêu đề
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal text-slate-900 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-2 gap-2.5 min-w-0">
            <label className="block font-bold text-slate-700 min-w-0">
              Ngày
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="block font-bold text-slate-700 min-w-0">
              Loại
              <select
                value={type}
                onChange={(e) => setType(e.target.value as HealthEvent['type'])}
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-2 font-normal text-slate-900 bg-white text-xs focus:border-emerald-500 focus:outline-none"
              >
                {eventTypeOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 min-w-0">
            <label className="block font-bold text-slate-700 min-w-0">
              Cơ sở y tế
              <input
                value={facility}
                onChange={(e) => setFacility(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="block font-bold text-slate-700 min-w-0">
              Bác sĩ
              <input
                value={doctorName}
                onChange={(e) => setDoctorName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
              />
            </label>
          </div>

          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-slate-700">Chẩn đoán</span>
              <button
                type="button"
                onClick={() => setDiagnoses((prev) => [...prev, ''])}
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
              >
                <Plus className="w-3 h-3" />
                <span>Thêm</span>
              </button>
            </div>
            {diagnoses.map((diag, idx) => (
              <div key={idx} className="flex items-center gap-1.5 min-w-0">
                <input
                  value={diag}
                  onChange={(e) =>
                    setDiagnoses((prev) => prev.map((item, i) => (i === idx ? e.target.value : item)))
                  }
                  className="flex-1 min-w-0 rounded-xl border border-slate-200 px-3 py-2 font-normal text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setDiagnoses((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label="Xóa chẩn đoán"
                  className="h-9 w-9 shrink-0 rounded-xl border border-slate-200 text-slate-400 hover:bg-rose-50 hover:text-rose-600 inline-flex items-center justify-center"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-slate-700">Đơn thuốc</span>
              <button
                type="button"
                onClick={() =>
                  setMedications((prev) => [
                    ...prev,
                    {
                      name: '',
                      dosage: '',
                      frequency: '',
                      duration: '',
                      quantity: '',
                      timing: '',
                      instructions: '',
                    },
                  ])
                }
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
              >
                <Plus className="w-3 h-3" />
                <span>Thêm</span>
              </button>
            </div>
            {medications.map((med, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 space-y-1.5 min-w-0"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <input
                    aria-label="Tên thuốc"
                    placeholder="Tên thuốc"
                    value={med.name}
                    onChange={(e) =>
                      setMedications((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item)),
                      )
                    }
                    className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-semibold text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setMedications((prev) => prev.filter((_, i) => i !== idx))}
                    aria-label="Xóa thuốc"
                    className="h-8 w-8 shrink-0 rounded-lg border border-slate-200 bg-white text-slate-400 hover:bg-rose-50 hover:text-rose-600 inline-flex items-center justify-center"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5 min-w-0">
                  <input
                    aria-label="Liều dùng"
                    placeholder="Liều"
                    value={med.dosage}
                    onChange={(e) =>
                      setMedications((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, dosage: e.target.value } : item)),
                      )
                    }
                    className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-800 text-[11px] focus:border-emerald-500 focus:outline-none"
                  />
                  <input
                    aria-label="Tần suất"
                    placeholder="Tần suất"
                    value={med.frequency}
                    onChange={(e) =>
                      setMedications((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, frequency: e.target.value } : item)),
                      )
                    }
                    className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-800 text-[11px] focus:border-emerald-500 focus:outline-none"
                  />
                  <input
                    aria-label="Thời gian"
                    placeholder="Thời gian"
                    value={med.duration}
                    onChange={(e) =>
                      setMedications((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, duration: e.target.value } : item)),
                      )
                    }
                    className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-800 text-[11px] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5 min-w-0">
                  <input
                    aria-label="Số lượng"
                    placeholder="Số lượng"
                    value={med.quantity}
                    onChange={(e) =>
                      setMedications((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, quantity: e.target.value } : item)),
                      )
                    }
                    className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-800 text-[11px] focus:border-emerald-500 focus:outline-none"
                  />
                  <input
                    aria-label="Cách dùng"
                    placeholder="Cách dùng"
                    value={med.instructions}
                    onChange={(e) =>
                      setMedications((prev) =>
                        prev.map((item, i) =>
                          i === idx ? { ...item, instructions: e.target.value } : item,
                        ),
                      )
                    }
                    className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-800 text-[11px] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-slate-700">Chỉ số</span>
              <button
                type="button"
                onClick={() =>
                  setMetrics((prev) => [...prev, { name: '', value: '', unit: '', refRange: '' }])
                }
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
              >
                <Plus className="w-3 h-3" />
                <span>Thêm</span>
              </button>
            </div>
            {metrics.map((met, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-2 space-y-1.5 min-w-0"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <input
                    aria-label="Tên chỉ số"
                    placeholder="Tên chỉ số"
                    value={met.name}
                    onChange={(e) =>
                      setMetrics((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item)),
                      )
                    }
                    className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-semibold text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setMetrics((prev) => prev.filter((_, i) => i !== idx))}
                    aria-label="Xóa chỉ số"
                    className="h-8 w-8 shrink-0 rounded-lg border border-slate-200 bg-white text-slate-400 hover:bg-rose-50 hover:text-rose-600 inline-flex items-center justify-center"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5 min-w-0">
                  <input
                    aria-label="Giá trị"
                    placeholder="Giá trị"
                    value={met.value}
                    onChange={(e) =>
                      setMetrics((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, value: e.target.value } : item)),
                      )
                    }
                    className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-800 text-[11px] tabular-nums focus:border-emerald-500 focus:outline-none"
                  />
                  <input
                    aria-label="Đơn vị"
                    placeholder="Đơn vị"
                    value={met.unit}
                    onChange={(e) =>
                      setMetrics((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, unit: e.target.value } : item)),
                      )
                    }
                    className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-800 text-[11px] focus:border-emerald-500 focus:outline-none"
                  />
                  <input
                    aria-label="Tham chiếu"
                    placeholder="Tham chiếu"
                    value={met.refRange}
                    onChange={(e) =>
                      setMetrics((prev) =>
                        prev.map((item, i) =>
                          i === idx ? { ...item, refRange: e.target.value } : item,
                        ),
                      )
                    }
                    className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-slate-800 text-[11px] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>
            ))}
          </div>

          <label className="block font-bold text-slate-700">
            Lời dặn
            <textarea
              rows={2}
              value={advice}
              onChange={(e) => setAdvice(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
            />
          </label>

          <label className="block font-bold text-slate-700">
            Tái khám
            <input
              type="date"
              value={nextFollowUp}
              onChange={(e) => setNextFollowUp(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
            />
          </label>

          <label className="block font-bold text-slate-700">
            Ghi chú
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-normal text-slate-900 text-xs focus:border-emerald-500 focus:outline-none"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="min-h-[40px] px-4 py-2 rounded-xl border border-slate-200 font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="submit"
            disabled={isSaving || !title.trim()}
            className="min-h-[40px] px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-extrabold shadow-xs transition-all disabled:opacity-50"
          >
            {isSaving ? 'Đang lưu...' : 'Lưu'}
          </button>
        </div>
      </form>
    </div>
  );
}

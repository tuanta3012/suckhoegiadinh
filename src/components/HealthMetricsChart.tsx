import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface HealthMetricChartPoint {
  date: string;
  value: number | string | undefined;
  secondaryValue?: number;
  unit: string;
}

interface HealthMetricsChartProps {
  data: HealthMetricChartPoint[];
  metricName: string;
  standardKey?: string;
  minNormal?: number;
  maxNormal?: number;
}

export default function HealthMetricsChart({
  data,
  metricName,
  minNormal,
  maxNormal,
}: HealthMetricsChartProps) {
  if (data.length === 1) {
    const singlePoint = data[0];
    const formattedValue =
      typeof singlePoint.secondaryValue === 'number'
        ? `${singlePoint.value}/${singlePoint.secondaryValue}`
        : `${singlePoint.value}`;
    return (
      <div className="p-4 sm:p-5 text-center bg-slate-50 rounded-xl space-y-2 border border-slate-100">
        <div className="inline-flex flex-wrap items-center justify-center gap-2 rounded-lg bg-white px-3 py-1.5 border border-slate-200 shadow-2xs">
          <span className="text-xs font-semibold text-slate-500">{singlePoint.date}</span>
          <span className="text-sm font-extrabold text-slate-900 tabular-nums">
            {formattedValue} {singlePoint.unit}
          </span>
        </div>
        <p className="text-xs text-slate-500">
          Chỉ số này hiện chỉ ghi nhận 1 mốc dữ liệu, cần từ 2 mốc thời gian trở lên để hiển thị biểu đồ diễn biến
        </p>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="p-6 text-center text-xs text-slate-500 bg-slate-50 rounded-xl">
        Chưa có dữ liệu hợp lệ để hiển thị biểu đồ diễn biến {metricName}.
      </div>
    );
  }

  const hasDualSeries = data.some((point) => typeof point.secondaryValue === 'number');
  const hasRange = !hasDualSeries && typeof minNormal === 'number' && typeof maxNormal === 'number';

  return (
    <div className="w-full min-w-0 space-y-2">
      {hasDualSeries && (
        <div className="flex items-center justify-end gap-4 px-1 text-[11px] font-semibold text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />
            Tâm thu
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-sky-600" />
            Tâm trương
          </span>
        </div>
      )}
      <div className="h-56 sm:h-64 md:h-72 w-full min-w-0 overflow-hidden pt-2">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={data} margin={{ top: 12, right: 16, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="colorMetric" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#059669" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#059669" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#64748b' }}
              tickMargin={6}
              minTickGap={16}
              stroke="#cbd5e1"
            />
            <YAxis
              width={44}
              tick={{ fontSize: 11, fill: '#64748b' }}
              stroke="#cbd5e1"
              domain={['auto', 'auto']}
            />
            {hasRange && (
              <ReferenceArea
                y1={minNormal}
                y2={maxNormal}
                fill="#10b981"
                fillOpacity={0.12}
                stroke="#10b981"
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
            )}
            <Tooltip
              contentStyle={{
                backgroundColor: '#0f172a',
                borderRadius: '12px',
                color: '#fff',
                border: 'none',
                fontSize: '12px',
                boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
              }}
              formatter={(value, name) => [
                `${value} ${data[0]?.unit || ''}`,
                hasDualSeries ? String(name) : metricName,
              ]}
            />
            <Area
              type="monotone"
              dataKey="value"
              name={hasDualSeries ? 'Tâm thu' : metricName}
              stroke="#059669"
              strokeWidth={3}
              fillOpacity={1}
              fill="url(#colorMetric)"
            />
            {hasDualSeries && (
              <Area
                type="monotone"
                dataKey="secondaryValue"
                name="Tâm trương"
                stroke="#0284c7"
                strokeWidth={2.5}
                fillOpacity={0}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

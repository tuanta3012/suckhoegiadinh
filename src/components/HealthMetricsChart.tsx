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
    return (
      <div className="p-6 text-center text-xs text-slate-500 bg-slate-50 rounded-xl">
        Chỉ số này hiện chỉ ghi nhận 1 mốc dữ liệu, cần từ 2 mốc thời gian trở lên để hiển thị biểu đồ diễn biến
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

  const hasRange = typeof minNormal === 'number' && typeof maxNormal === 'number';

  return (
    <div className="h-56 w-full pt-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
          <defs>
            <linearGradient id="colorMetric" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#059669" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#059669" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} stroke="#cbd5e1" />
          <YAxis
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
              label={{
                value: 'Khoảng an toàn',
                fill: '#047857',
                fontSize: 10,
                position: 'insideTopRight',
              }}
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
            formatter={(value) => [`${value} ${data[0]?.unit || ''}`, metricName]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#059669"
            strokeWidth={3}
            fillOpacity={1}
            fill="url(#colorMetric)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

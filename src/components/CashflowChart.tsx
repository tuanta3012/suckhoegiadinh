import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDecimal } from '../utils/formatters';

interface CashflowChartPoint {
  monthKey: string;
  label: string;
  principalMillion: number;
  interestMillion: number;
}

interface CashflowChartProps {
  data: CashflowChartPoint[];
}

export const CashflowChart: React.FC<CashflowChartProps> = ({ data }) => (
  <ResponsiveContainer width="100%" height="100%">
    <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 5 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" />
      <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#cbd5e1' }} />
      <YAxis
        tick={{ fontSize: 10, fill: '#cbd5e1' }}
        tickFormatter={(value) => `${formatDecimal(value / 1000, 1)}T`}
      />
      <Tooltip
        formatter={(value: number | string, name: string) => [
          `${Number(value).toLocaleString('vi-VN')} Tr VNĐ`,
          name === 'principalMillion' ? 'Gốc' : 'Lãi',
        ]}
        contentStyle={{
          backgroundColor: '#0f172a',
          color: '#fff',
          borderRadius: '8px',
          fontSize: '11px',
          border: '1px solid #334155',
        }}
      />
      <Bar dataKey="principalMillion" name="principalMillion" stackId="a" fill="#10b981" />
      <Bar
        dataKey="interestMillion"
        name="interestMillion"
        stackId="a"
        fill="#f59e0b"
        radius={[3, 3, 0, 0]}
      />
    </BarChart>
  </ResponsiveContainer>
);

'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Eye, FileText, ArrowUpRight, Shield, AlertTriangle, ShieldAlert, Clock, History } from 'lucide-react';
import type { RiskLevel, CategoryName } from '@/lib/types';
import { getRiskGrade } from '@/lib/utils';
import { getCompanyDomain, getInitials } from '@/lib/company-display';

interface TOSCardProps {
  analysis: {
    id: string;
    companyName: string | null;
    overallRisk: RiskLevel;
    clauseCount: number;
    viewCount: number;
    categories: CategoryName[];
    createdAt: string;
    score: number;
    isSuperseded?: boolean;
    latestId?: string | null;
  };
}

const STALE_MONTHS = 6;
const VERY_STALE_MONTHS = 12;
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30;

function getAgeBadge(createdAt: string): { label: string; className: string } | null {
  const ageMonths = (Date.now() - new Date(createdAt).getTime()) / MS_PER_MONTH;
  if (ageMonths >= VERY_STALE_MONTHS) {
    return { label: `${Math.floor(ageMonths)} months old`, className: 'tos-card__age tos-card__age--very-stale' };
  }
  if (ageMonths >= STALE_MONTHS) {
    return { label: `${Math.floor(ageMonths)} months old`, className: 'tos-card__age tos-card__age--stale' };
  }
  return null;
}

export const TOSCard = ({ analysis }: TOSCardProps) => {
  const [logoError, setLogoError] = useState(false);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getScoreGrade = (score: number): { letter: string; class: string } => {
    const letter = getRiskGrade(score);
    return { letter, class: `tos-card__grade--${letter.toLowerCase()}` };
  };

  const getRiskConfig = (risk: RiskLevel) => {
    switch (risk) {
      case 'high':
        return {
          label: 'High Risk',
          icon: ShieldAlert,
          cardClass: 'tos-card--high',
          badgeClass: 'tos-card__badge--high',
          viewClass: 'tos-card__view--high',
          gradientClass: 'tos-card__gradient--high',
        };
      case 'medium':
        return {
          label: 'Moderate',
          icon: AlertTriangle,
          cardClass: 'tos-card--medium',
          badgeClass: 'tos-card__badge--medium',
          viewClass: 'tos-card__view--medium',
          gradientClass: 'tos-card__gradient--medium',
        };
      default:
        return {
          label: 'Low Risk',
          icon: Shield,
          cardClass: 'tos-card--low',
          badgeClass: 'tos-card__badge--low',
          viewClass: 'tos-card__view--low',
          gradientClass: 'tos-card__gradient--low',
        };
    }
  };

  const getInitialsBgColor = (name: string | null): string => {
    if (!name) return 'from-slate-600 to-slate-700';
    const colors = [
      'from-blue-500 to-blue-600',
      'from-purple-500 to-purple-600',
      'from-emerald-500 to-emerald-600',
      'from-amber-500 to-amber-600',
      'from-rose-500 to-rose-600',
      'from-cyan-500 to-cyan-600',
      'from-indigo-500 to-indigo-600',
      'from-pink-500 to-pink-600',
    ];
    const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  };

  const riskConfig = getRiskConfig(analysis.overallRisk);
  const scoreGrade = getScoreGrade(analysis.score);
  const RiskIcon = riskConfig.icon;
  const domain = getCompanyDomain(analysis.companyName);
  const logoUrl = domain ? `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${domain}&size=128` : null;
  const ageBadge = getAgeBadge(analysis.createdAt);
  const isSuperseded = !!analysis.isSuperseded;

  return (
    <Link href={`/analysis/${analysis.id}`} className="block h-full">
      <article className={`tos-card ${riskConfig.cardClass}`}>
        <div className={`tos-card__gradient ${riskConfig.gradientClass}`} />
        
        <div className="tos-card__content">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <div className={`tos-card__badge ${riskConfig.badgeClass}`}>
                <RiskIcon className="w-3.5 h-3.5" />
                <span>{riskConfig.label}</span>
              </div>
              <span className="tos-card__ai-tag" title="AI-generated analysis — verify against the original document">AI</span>
            </div>

            <div className="text-right">
              <div className={`tos-card__grade ${scoreGrade.class}`}>
                {scoreGrade.letter}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {analysis.score}/100
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 mb-3">
            <div className="tos-card__logo">
              {logoUrl && !logoError ? (
                <Image
                  src={logoUrl}
                  alt={`${analysis.companyName} logo`}
                  width={40}
                  height={40}
                  className="tos-card__logo-img"
                  onError={() => setLogoError(true)}
                  unoptimized
                />
              ) : (
                <div className={`tos-card__logo-initials bg-gradient-to-br ${getInitialsBgColor(analysis.companyName)}`}>
                  {getInitials(analysis.companyName)}
                </div>
              )}
            </div>
            <div>
              <h3 className="tos-card__title">
                {analysis.companyName || 'Untitled Analysis'}
              </h3>
              <p className="text-xs text-slate-500">
                {formatDate(analysis.createdAt)}
              </p>
            </div>
          </div>

          <div className="mt-auto">
            {(ageBadge || isSuperseded) && (
              <div className="tos-card__warnings">
                {ageBadge && (
                  <span className={ageBadge.className}>
                    <Clock className="w-3 h-3" />
                    {ageBadge.label}
                  </span>
                )}
                {isSuperseded && (
                  <span className="tos-card__age tos-card__age--superseded">
                    <History className="w-3 h-3" />
                    Superseded
                  </span>
                )}
              </div>
            )}

            {analysis.categories.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {analysis.categories.slice(0, 2).map((category, idx) => (
                  <span key={idx} className="tos-card__tag">
                    {category}
                  </span>
                ))}
                {analysis.categories.length > 2 && (
                  <span className="text-xs text-slate-500 py-1">
                    +{analysis.categories.length - 2}
                  </span>
                )}
              </div>
            )}

            <div className="tos-card__stats">
              <div className="tos-card__stat">
                <FileText className="w-4 h-4" />
                <span>{analysis.clauseCount}</span>
              </div>
              <div className="tos-card__stat">
                <Eye className="w-4 h-4" />
                <span>{analysis.viewCount.toLocaleString()}</span>
              </div>
              
              <div className="ml-auto">
                <span className={`tos-card__view ${riskConfig.viewClass}`}>
                  View
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </span>
              </div>
            </div>
          </div>
        </div>
      </article>
    </Link>
  );
};

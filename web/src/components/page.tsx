/** Page-level layout pieces shared by every portal screen. */
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export function PageHeader({
  title,
  subtitle,
  actions,
  icon,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head__text">
        <h1>
          {icon}
          {title}
        </h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </div>
  );
}

/** In-page tabs rendered as links, so each view stays addressable and back-able. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: ReactNode; count?: number }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          className={value === tab.id ? 'tab tab--on' : 'tab'}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {typeof tab.count === 'number' && <span className="tab__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Breadcrumb trail; the last crumb is plain text, not a link. */
export function Crumbs({ items }: { items: Array<{ to?: string; label: ReactNode }> }) {
  return (
    <nav className="crumbs" aria-label="breadcrumb">
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span className="crumbs__sep" aria-hidden="true">/</span>}
          {item.to ? <NavLink to={item.to}>{item.label}</NavLink> : <span aria-current="page">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** Two-column responsive grid used by the detail screens. */
export function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return <div className={`grid grid--${cols}`}>{children}</div>;
}

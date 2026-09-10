"""Causal features and separate future labels for BAPI inventory research."""
import numpy as np

FEATURES = ['market_logit', 'market_logit_x_progress', 'reference_gap_z',
            'binance_gap_z', 'relative_gap_z', 'binance_500ms', 'up_mid_delta_3s',
            'depth_imbalance_difference', 'combined_spread', 'log_remaining',
            'up_ask_depth_log', 'down_ask_depth_log']
PRICE_H = [1, 5, 15, 30]
JOINT_H = [5, 15, 30, 60]
OFFSETS = [.01, .03, .05]


def asof(times, target):
    return int(np.searchsorted(times, target, side='right') - 1)


def number(v):
    return float(v) if v is not None else np.nan


def prepare(data):
    ticks = data['ticks']
    times = np.array([t['t'] for t in ticks], dtype=float)
    assert np.all(np.diff(times) >= 0)
    vals = {}
    for key in ['bz', 'cl', 'upAsk', 'dnAsk', 'upBid', 'dnBid']:
        vals[key] = np.array([number(t.get(key)) for t in ticks])
    for side in ['up', 'down']:
        for field in ['bids', 'asks']:
            vals[f'{side}_{field}_depth'] = np.array([sum(float(q[1]) for q in t[side][field]) for t in ticks])
    vals['times'] = times
    start = data['windowStart'] * 1000
    for name, get in [('bz_clock', lambda t: t.get('binanceAtMs')),
                      ('cl_clock', lambda t: t.get('chainlinkAtMs')),
                      ('up_clock', lambda t: t['up'].get('depthTs')),
                      ('down_clock', lambda t: t['down'].get('depthTs'))]:
        vals[name] = np.array([(number(get(t))-start)/1000 for t in ticks])
    for key in ['bz', 'cl']:
        usable = np.where(np.isfinite(vals[key]) & (vals[key] > 0) & (times <= 2))[0]
        vals[key+'_open_observed'] = vals[key][usable[0]] if len(usable) else np.nan
    fresh = np.ones(len(times),dtype=bool)
    for key in ['up_clock','down_clock']:
        age=times-vals[key]
        fresh &= np.isfinite(age)&(age>=-.001)&(age<=1)
    for key in ['upAsk','dnAsk','upBid','dnBid']:
        fresh &= np.isfinite(vals[key])&(vals[key]>0)&(vals[key]<1)
    vals['fresh_books']=fresh
    return vals


def book_fresh(v, i, clock):
    if i < 0 or clock-v['times'][i] > 1:
        return False
    for k in ['up_clock', 'down_clock']:
        age = clock-v[k][i]
        if not np.isfinite(age) or not -.001 <= age <= 1:
            return False
    return all(np.isfinite(v[k][i]) and 0 < v[k][i] < 1 for k in ['upAsk','dnAsk','upBid','dnBid'])


def causal_features(v, clock):
    """Reads observations at or before clock; no outcome or future-price inputs."""
    ts = v['times']; i = asof(ts, clock)
    if not book_fresh(v, i, clock):
        return None
    for k, maxage in [('bz_clock',1),('cl_clock',90)]:
        age = clock-v[k][i]
        if not np.isfinite(age) or not -.001 <= age <= maxage:
            return None
    bz, cl = v['bz'][i], v['cl'][i]
    if not all(np.isfinite(x) and x > 0 for x in [bz,cl,v['bz_open_observed'],v['cl_open_observed']]):
        return None
    jhalf, j3 = asof(ts, clock-.5), asof(ts, clock-3)
    if min(jhalf,j3) < 0:
        return None
    upmid = (v['upAsk'][i]+v['upBid'][i])/2
    dnmid = (v['dnAsk'][i]+v['dnBid'][i])/2
    base = np.clip(upmid/(upmid+dnmid),.01,.99)
    lgt = np.log(base/(1-base))
    oldmid = (v['upAsk'][j3]+v['upBid'][j3])/2
    delta = upmid-oldmid
    mom = np.log(bz/v['bz'][jhalf]) if v['bz'][jhalf] > 0 else 0
    grid = np.arange(max(1,clock-30),clock+1e-6,1)
    ii = np.searchsorted(ts,grid,side='right')-1
    past = v['bz'][ii[ii >= 0]]
    if len(past)<3 or np.any(~np.isfinite(past)) or np.any(past<=0):
        return None
    # Only in-round past observations. The fixed floor prevents zero division.
    sigma = max(1e-6,float(np.sqrt(np.mean(np.diff(np.log(past))**2))))
    denom = sigma*np.sqrt(300-clock)
    gz = np.clip(np.log(cl/v['cl_open_observed'])/denom,-4,4)
    bz_z = np.clip(np.log(bz/v['bz_open_observed'])/denom,-4,4)
    imbalances=[]
    for side in ['up','down']:
        b,a=v[side+'_bids_depth'][i],v[side+'_asks_depth'][i]
        imbalances.append((b-a)/max(b+a,1e-12))
    spread = v['upAsk'][i]-v['upBid'][i]+v['dnAsk'][i]-v['dnBid'][i]
    x = [lgt,lgt*clock/300,gz,bz_z,np.clip(bz_z-gz,-4,4),np.clip(mom/.0001,-4,4),
         delta/.02,(imbalances[0]-imbalances[1])/2,spread/.02,np.log(300-clock),
         np.log1p(v['up_asks_depth'][i]),np.log1p(v['down_asks_depth'][i])]
    if not np.all(np.isfinite(x)):
        return None
    direction = 1 if mom > 0 and delta >= .02-1e-9 else -1 if mom < 0 and delta <= -.02+1e-9 else 0
    return np.array(x),float(base),np.array([v['upAsk'][i],v['dnAsk'][i]]),direction


def extract_round(data):
    v=prepare(data);ts=v['times'];rows=[]
    for clock in range(10,291,10):
        f=causal_features(v,clock)
        if f is None:
            continue
        x,base,asks,direction=f
        future=np.full((len(PRICE_H),2),np.nan)
        for hi,h in enumerate(PRICE_H):
            if clock+h > 298:continue
            j=asof(ts,clock+h)
            if book_fresh(v,j,clock+h):future[hi]=[v['upAsk'][j],v['dnAsk'][j]]
        j=asof(ts,clock+.520)
        arrival=np.array([v['upAsk'][j],v['dnAsk'][j]]) if book_fresh(v,j,clock+.520) else np.full(2,np.nan)
        reject=np.where(np.isfinite(arrival),arrival<=asks-.01+1e-9,np.nan)
        touch=np.full((len(JOINT_H),len(OFFSETS),2),np.nan)
        cross=np.full_like(touch,np.nan)
        for hi,h in enumerate(JOINT_H):
            if clock+h>298:continue
            # Include the as-of arrival quote and later observations through h.
            low=asof(ts,clock+.520);high=asof(ts,clock+h)
            if low<0 or high<low:continue
            ids=np.arange(low,high+1)[v['fresh_books'][low:high+1]]
            if len(ids) and ids[0]==low and not book_fresh(v,low,clock+.520):ids=ids[1:]
            if not len(ids):continue
            lows=np.array([np.min(v['upAsk'][ids]),np.min(v['dnAsk'][ids])])
            for oi,offset in enumerate(OFFSETS):
                quotes=asks-offset
                if np.any(quotes<.01-1e-9):continue
                touch[hi,oi]=(lows<=quotes+1e-9)
                cross[hi,oi]=(lows<quotes-1e-9)
        rows.append(dict(t=clock,x=x,base=base,asks=asks,direction=direction,
                         future=future,arrival=arrival,reject=reject,touch=touch,cross=cross))
    return rows


def split(day):
    if day<='2026-09-05':return 0
    if day=='2026-09-06':return 1
    if day<='2026-09-09':return 2
    return 3

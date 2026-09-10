#!/usr/bin/env python3
"""BAPI outcome/price-opportunity calibration; never credits maker queue fills."""
import argparse
import csv
import gzip
import hashlib
import json
import time
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from inventory_calibration_features import FEATURES,PRICE_H,JOINT_H,OFFSETS,extract_round,split

ROOT=Path(__file__).resolve().parents[2]
SPLITS=['train','validation','retrospective_test','latest_test']
parser=argparse.ArgumentParser()
parser.add_argument('--out',default='data/reports/wallet3048-inventory-calibration-2026-09-03_10')
parser.add_argument('--extract-only',action='store_true')
args=parser.parse_args()
OUT=Path(args.out).resolve();PLAN=json.loads((OUT/'study-plan.json').read_text())
FEATURE_HASH=hashlib.sha256(Path(__file__).with_name('inventory_calibration_features.py').read_bytes()).hexdigest()


def clean(x):
    if isinstance(x,dict):return {str(k):clean(v) for k,v in x.items()}
    if isinstance(x,(list,tuple)):return [clean(v) for v in x]
    if isinstance(x,np.ndarray):return clean(x.tolist())
    if isinstance(x,(np.integer,)):return int(x)
    if isinstance(x,(float,np.floating)):return float(x) if np.isfinite(x) else None
    if isinstance(x,np.bool_):return bool(x)
    return x


def save(name,obj):
    (OUT/name).write_text(json.dumps(clean(obj),indent=2,allow_nan=False)+'\n')


def csvwrite(name,rows):
    if not rows:return
    with (OUT/name).open('w') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(clean(rows))


def extract():
    from datetime import datetime,timezone
    start=int(datetime.fromisoformat(PLAN['from'].replace('Z','+00:00')).timestamp())
    end=int(datetime.fromisoformat(PLAN['toExclusive'].replace('Z','+00:00')).timestamp())
    (OUT/'features').mkdir(exist_ok=True)
    blocks=[];stats=[]
    for ri,ws in enumerate(range(start,end,300)):
        slug=f'btc-updown-5m-{ws}';src=OUT/'feeds'/f'{slug}.json.gz';cache=OUT/'features'/f'{slug}.npz'
        while not src.exists() and not (OUT/'manifest.json').exists():time.sleep(.5)
        if not src.exists():continue
        for attempt in range(5):
            try:
                raw=src.read_bytes();d=json.loads(gzip.decompress(raw));break
            except Exception:
                if attempt==4:raise
                time.sleep(.5)
        day=datetime.fromtimestamp(ws+7200,tz=timezone.utc).strftime('%Y-%m-%d')
        if not d['audit']['eligible']:
            stats.append(dict(slug=slug,day=day,eligible=False,feature_rows=0));continue
        sh=hashlib.sha256(raw).hexdigest();b=None
        if cache.exists():
            with np.load(cache,allow_pickle=False) as old:
                if str(old['feature_hash'])==FEATURE_HASH and str(old['feed_hash'])==sh:b={k:old[k] for k in old.files}
        if b is None:
            rows=extract_round(d)
            if not rows:
                stats.append(dict(slug=slug,day=day,eligible=True,feature_rows=0));continue
            b={key:np.array([r[key] for r in rows]) for key in rows[0]}
            b.update(ri=np.full(len(rows),ri),split=np.full(len(rows),split(day)),y=np.full(len(rows),int(d['winSide']=='Up')),
                     feature_hash=np.array(FEATURE_HASH),feed_hash=np.array(sh))
            np.savez_compressed(cache,**b)
        stats.append(dict(slug=slug,day=day,eligible=True,feature_rows=len(b['y'])))
        blocks.append(b)
        if ri%96==0:print(json.dumps(dict(phase='features',round_index=ri,rows=sum(len(q['y']) for q in blocks))),flush=True)
    assert blocks,'No usable feature rows'
    data={key:np.concatenate([b[key] for b in blocks]) for key in blocks[0] if key not in ['feature_hash','feed_hash']}
    np.savez_compressed(OUT/'features.npz',**data)
    save('feature-coverage.json',dict(featureHash=FEATURE_HASH,rows=stats))
    print(json.dumps(dict(phase='features-complete',rows=len(data['y']),rounds=len(np.unique(data['ri'])))),flush=True)
    return data


def weights(ri):
    _,inv,counts=np.unique(ri,return_inverse=True,return_counts=True)
    w=1/counts[inv]
    return w/w.mean()


def avg_round(values,ri):
    ids,inv,counts=np.unique(ri,return_inverse=True,return_counts=True)
    return ids,np.bincount(inv,weights=values)/counts


def block_ci(values,n=1000,block=12):
    values=np.asarray(values);size=len(values)
    if not size:return [None,None]
    rng=np.random.default_rng(3048);est=[]
    for _ in range(n):
        starts=rng.integers(0,size,size=int(np.ceil(size/block)))
        idx=(starts[:,None]+np.arange(min(block,size)))[...].ravel()%size
        est.append(np.mean(values[idx[:size]]))
    return list(np.quantile(est,[.025,.975]))


def reliability(y,p,ri):
    w=weights(ri);rows=[];bins=np.minimum((np.clip(p,0,1)*10).astype(int),9)
    for bin_index in range(10):
        lo=bin_index/10;m=bins==bin_index
        if m.any():rows.append(dict(bin_low=round(lo,1),observations=int(m.sum()),rounds=len(np.unique(ri[m])),
            predicted=np.average(p[m],weights=w[m]),observed=np.average(y[m],weights=w[m]),weight=w[m].sum()))
    return rows


def metrics(y,p,ri):
    p=np.clip(p,1e-6,1-1e-6);w=weights(ri)
    ids,b=avg_round((y-p)**2,ri)
    return dict(rows=len(y),rounds=len(ids),brier=b.mean(),brier_ci=block_ci(b),
        log_loss=np.average(-(y*np.log(p)+(1-y)*np.log(1-p)),weights=w),
        directional_accuracy=np.average((p>=.5)==y,weights=w),
        calibration=reliability(y,p,ri))


def fit_logistic(x,y,ri,c):
    model=make_pipeline(StandardScaler(),LogisticRegression(C=c,max_iter=500,solver='lbfgs'))
    model.fit(x,y,logisticregression__sample_weight=weights(ri))
    return model


def serialize(model,names):
    scale=model.steps[0][1];reg=model.steps[-1][1]
    return dict(features=names,mean=scale.mean_,scale=scale.scale_,coef=reg.coef_,intercept=reg.intercept_,
                regularization=getattr(reg,'C',getattr(reg,'alpha',None)))


def probability(d):
    x,y,ri=d['x'],d['y'],d['ri'];tr=d['split']==0;va=d['split']==1
    candidates=[dict(name='market-midpoint',model=None,columns=None,p=d['base'])]
    for name,cols in [('market-logit-calibration',[0]),('state-logistic',list(range(x.shape[1])))]:
        for c in PLAN['regularizationC']:
            model=fit_logistic(x[tr][:,cols],y[tr],ri[tr],c)
            candidates.append(dict(name=f'{name}-C{c}',model=model,columns=cols,p=model.predict_proba(x[:,cols])[:,1]))
    scores=[]
    for q in candidates:
        score=np.average((q['p'][va]-y[va])**2,weights=weights(ri[va]));q['validation_brier']=score
        scores.append(dict(model=q['name'],validation_brier=score))
    chosen=min(candidates,key=lambda q:q['validation_brier'])
    frozen=dict(selected=chosen['name'],selection=scores,trainedOn=SPLITS[0],selectedOn=SPLITS[1],
        featureHash=FEATURE_HASH,model=serialize(chosen['model'],[FEATURES[i] for i in chosen['columns']]) if chosen['model'] else None)
    # Save the selection before calculating test metrics.
    save('selected-probability-model.json',frozen)
    reports={};flat=[]
    for s,label in enumerate(SPLITS):
        m=d['split']==s;reports[label]={}
        for q in candidates:
            result=metrics(y[m],q['p'][m],ri[m]);reports[label][q['name']]=result
            flat.append(dict(split=label,model=q['name'],rows=result['rows'],rounds=result['rounds'],
                brier=result['brier'],log_loss=result['log_loss'],directional_accuracy=result['directional_accuracy']))
        _,diff=avg_round((chosen['p'][m]-y[m])**2-(d['base'][m]-y[m])**2,ri[m])
        reports[label]['selected_minus_market_brier']=dict(mean=diff.mean(),ci=block_ci(diff))
    save('probability-results.json',dict(selected=chosen['name'],splits=reports));csvwrite('probability-metrics.csv',flat)
    np.savez_compressed(OUT/'probability-predictions.npz',ri=ri,t=d['t'],split=d['split'],y=y,market=d['base'],calibrated=chosen['p'])
    fig,ax=plt.subplots(1,2,figsize=(10,4))
    for plot,label in zip(ax,['retrospective_test','latest_test']):
        plot.plot([0,1],[0,1],'--',color='gray',linewidth=1)
        for name in dict.fromkeys(['market-midpoint',chosen['name']]):
            bins=reports[label][name]['calibration'];plot.plot([r['predicted'] for r in bins],[r['observed'] for r in bins],'o-',label=name)
        plot.set(title=label.replace('_',' '),xlabel='Predicted UP probability',ylabel='Observed UP frequency',xlim=(0,1),ylim=(0,1));plot.legend(fontsize=7)
    fig.tight_layout();fig.savefig(OUT/'probability-calibration.png',dpi=160);plt.close(fig)
    print(json.dumps(dict(phase='probability-complete',selected=chosen['name'])),flush=True)
    return chosen,reports


def prices(d):
    output=[];models=[];intervals=[]
    # Fit changes in best ask, with current asks supplied as observed features.
    x=np.column_stack([d['x'],d['asks']]);names=FEATURES+['up_ask','down_ask']
    for hi,h in enumerate(PRICE_H):
        valid=np.isfinite(d['future'][:,hi,:]).all(axis=1)
        tr=(d['split']==0)&valid;va=(d['split']==1)&valid
        target=d['future'][:,hi,:];change=target-d['asks']
        velocity=np.column_stack([d['x'][:,6],-d['x'][:,6]])*.02/3
        candidates=[('persistence',d['asks'],None),('three-second-velocity',np.clip(d['asks']+h*velocity,.01,.99),None)]
        for a in [1,10,100]:
            model=make_pipeline(StandardScaler(),Ridge(alpha=a))
            model.fit(x[tr],change[tr],ridge__sample_weight=weights(d['ri'][tr]))
            candidates.append((f'ridge-{a}',np.clip(d['asks']+model.predict(x),.01,.99),model))
        scores=[np.average(np.abs(pred[va]-target[va]).mean(axis=1),weights=weights(d['ri'][va])) for _,pred,_ in candidates]
        chosen=candidates[int(np.argmin(scores))]
        residual=target[va]-chosen[1][va]
        wv=weights(d['ri'][va]);bounds=[]
        for side in range(2):
            order=np.argsort(residual[:,side]);cum=np.cumsum(wv[order]);cum/=cum[-1]
            bounds.append(np.interp([.05,.95],cum,residual[order,side]))
        bounds=np.array(bounds)
        models.append(dict(horizon=h,selected=chosen[0],validation_mae=scores[int(np.argmin(scores))],
            validation_residual_05_95=bounds,
            model=serialize(chosen[2],names) if chosen[2] else None))
        for s,label in enumerate(SPLITS):
            m=(d['split']==s)&valid;w=weights(d['ri'][m])
            low=np.clip(chosen[1][m]+bounds[:,0],0,1);high=np.clip(chosen[1][m]+bounds[:,1],0,1)
            inside=(target[m]>=low-1e-9)&(target[m]<=high+1e-9)
            intervals.append(dict(split=label,horizon_seconds=h,selected=chosen[0],
                marginal_coverage=np.average(inside.mean(axis=1),weights=w),
                both_sides_coverage=np.average(inside.all(axis=1),weights=w),
                mean_width_cents=100*np.average((high-low).mean(axis=1),weights=w)))
            for name,pred,_ in candidates:
                error=np.abs(pred[m]-target[m]).mean(axis=1)
                output.append(dict(split=label,horizon_seconds=h,model=name,selected=name==chosen[0],rows=int(m.sum()),
                    rounds=len(np.unique(d['ri'][m])),mae_cents=100*np.average(error,weights=w)))
    save('selected-price-models.json',models);csvwrite('price-forecast-metrics.csv',output)
    csvwrite('price-forecast-intervals.csv',intervals)
    save('price-results.json',dict(models=models,metrics=output,intervals=intervals))
    print(json.dumps(dict(phase='prices-complete')),flush=True)
    return models,output


def joint(d):
    arrays=[];labels=[];metadata=[]
    for hi,h in enumerate(JOINT_H):
        for oi,offset in enumerate(OFFSETS):
            target=d['touch'][:,hi,oi,:];valid=np.isfinite(target).all(axis=1)
            idx=np.flatnonzero(valid)
            # Current information and fixed candidate horizon/offset only.
            xx=np.column_stack([d['x'][idx],np.full(len(idx),np.log(h)),np.full(len(idx),offset)])
            arrays.append(xx);labels.append(target[idx]);metadata.append(np.column_stack([idx,np.full(len(idx),hi),np.full(len(idx),oi)]))
    x=np.concatenate(arrays);yy=np.concatenate(labels);meta=np.concatenate(metadata).astype(int)
    idx=meta[:,0];ri=d['ri'][idx];sp=d['split'][idx];both=yy.prod(axis=1);tr=sp==0;va=sp==1
    candidates=[]
    for c in PLAN['regularizationC']:
        model=fit_logistic(x[tr],both[tr],ri[tr],c);p=model.predict_proba(x)[:,1]
        score=np.average((p[va]-both[va])**2,weights=weights(ri[va]));candidates.append((score,c,model,p))
    chosen=min(candidates,key=lambda q:q[0]);p=chosen[3]
    # Separately predicted side-touch events multiplied together: independence comparison only.
    marginal=[]
    for side in range(2):
        m=fit_logistic(x[tr],yy[tr,side],ri[tr],1);marginal.append(m)
    independent=marginal[0].predict_proba(x)[:,1]*marginal[1].predict_proba(x)[:,1]
    names=FEATURES+['log_horizon','target_offset']
    save('selected-joint-price-model.json',dict(target='both future best asks reach their initial-ask-minus-offset targets; NOT maker fills',
        selectedC=chosen[1],validation_brier=chosen[0],model=serialize(chosen[2],names),
        independent_up=serialize(marginal[0],names),independent_down=serialize(marginal[1],names)))
    result={};rows=[]
    for s,label in enumerate(SPLITS):
        m=sp==s
        result[label]=dict(joint_model=metrics(both[m],p[m],ri[m]),independence_model=metrics(both[m],independent[m],ri[m]))
        _,diff=avg_round((p[m]-both[m])**2-(independent[m]-both[m])**2,ri[m])
        result[label]['joint_minus_independence_brier']=dict(mean=diff.mean(),ci=block_ci(diff))
        for hi,h in enumerate(JOINT_H):
            for oi,offset in enumerate(OFFSETS):
                take=m&(meta[:,1]==hi)&(meta[:,2]==oi)
                w=weights(ri[take]);u=np.average(yy[take,0],weights=w);v=np.average(yy[take,1],weights=w)
                rows.append(dict(split=label,horizon_seconds=h,offset=offset,rows=int(take.sum()),rounds=len(np.unique(ri[take])),
                    up_touch=u,down_touch=v,both_touch=np.average(both[take],weights=w),
                    empirical_independence_product=u*v,joint_model_probability=np.average(p[take],weights=w)))
    save('joint-price-results.json',dict(splits=result,opportunities=rows));csvwrite('joint-price-opportunities.csv',rows)
    arrival=[]
    for s,label in enumerate(SPLITS):
        for side,side_name in enumerate(['Up','Down']):
            valid=(d['split']==s)&np.isfinite(d['arrival'][:,side])&(d['asks'][:,side]>.01)
            diff=d['arrival'][valid,side]-d['asks'][valid,side];w=weights(d['ri'][valid])
            arrival.append(dict(split=label,side=side_name,rows=int(valid.sum()),
                post_only_rejection_rate=np.average(d['reject'][valid,side],weights=w),
                mean_ask_change_cents=100*np.average(diff,weights=w),ask_change_p05_cents=100*np.quantile(diff,.05),
                ask_change_p95_cents=100*np.quantile(diff,.95),
                ask_over_plus_one_tick_rate=np.average(diff>.01+1e-9,weights=w)))
    csvwrite('arrival-price-audit.csv',arrival);save('arrival-price-audit.json',arrival)
    print(json.dumps(dict(phase='joint-prices-complete',C=chosen[1])),flush=True)
    return result,rows,arrival


def baseline_report():
    while not (OUT/'baseline.json').exists():time.sleep(.5)
    raw=json.loads((OUT/'baseline.json').read_text())['rows'];rows=[]
    def summarize(label,rs):
        used=[r for r in rs if r.get('eligible')];traded=[r for r in used if r.get('fillCount',0)>0]
        wins=[r['pnl'] for r in traded if r['pnl']>1e-8];losses=[r['pnl'] for r in traded if r['pnl']<-1e-8]
        scored=[r for r in traded if r.get('correct') is not None]
        all_pnl=np.array([r['pnl'] or 0 for r in used]);net=float(all_pnl.sum())
        return dict(period=label,expected=len(rs),eligible=len(used),traded=len(traded),entry_scored=len(scored),
            entry_correct=sum(r['correct'] for r in scored),entry_accuracy=sum(r['correct'] for r in scored)/len(scored) if scored else None,
            profitable=len(wins),losing=len(losses),zero=len(used)-len(wins)-len(losses),
            avg_win=float(np.mean(wins)) if wins else None,avg_loss=float(np.mean(losses)) if losses else None,
            net_pnl=net,mean_per_eligible=net/len(used) if used else None,mean_per_traded=net/len(traded) if traded else None,
            mean_pnl_ci=block_ci(all_pnl),profit_factor=sum(wins)/abs(sum(losses)) if losses else None,
            payoff_ratio=np.mean(wins)/abs(np.mean(losses)) if wins and losses else None,
            worst_round=min(all_pnl) if len(all_pnl) else None,
            correct_first_but_loss=sum(r.get('correct') is True and r['pnl']<0 for r in traded))
    for day in sorted(set(r.get('day','unknown') for r in raw)):
        rows.append(summarize(day,[r for r in raw if r.get('day','unknown')==day]))
    for s,label in enumerate(SPLITS):rows.append(summarize(label,[r for r in raw if r.get('day') and split(r['day'])==s]))
    rows.append(summarize('all',raw));save('baseline-summary.json',rows);csvwrite('baseline-daily.csv',rows)
    return rows


def report(d,chosen,prob,pm,price,jr,jrows,arrival,baseline):
    manifest=json.loads((OUT/'manifest.json').read_text());coverage=[]
    for day in sorted(set(r['day'] for r in manifest['rows'])):
        rr=[r for r in manifest['rows'] if r['day']==day]
        coverage.append(dict(day=day,expected=len(rr),eligible=sum(r['eligible'] for r in rr),errors=sum('error' in r for r in rr),
            early_start_missing=sum(r.get('firstSeconds') is not None and r['firstSeconds']>2 for r in rr),
            early_end=sum(r.get('lastSeconds') is not None and r['lastSeconds']<298 for r in rr),
            gaps_over_six_seconds=sum(r.get('maxGapSeconds',0)>6 for r in rr),empty_feed=sum(r.get('retainedTicks')==0 for r in rr),
            missing_winner=sum(r.get('winner') not in ['Up','Down'] for r in rr),missing_clocks=sum(r.get('missingClocks',0)>0 for r in rr)))
    csvwrite('coverage-daily.csv',coverage);save('coverage-summary.json',coverage)
    total=sum(r['eligible'] for r in manifest['rows']);rawframes=sum(r.get('rawCount',0) for r in manifest['rows'])
    mirrors=sum(r.get('mirrorLevels',0) for r in manifest['rows']);mirrorn=sum(r.get('checkedMirrorLevels',0) for r in manifest['rows'])
    summary=dict(range={k:PLAN[k] for k in ['from','toExclusive','timezone']},expected_rounds=len(manifest['rows']),
        eligible_rounds=total,excluded_rounds=len(manifest['rows'])-total,raw_frames=rawframes,feature_rows=len(d['y']),
        feature_rounds=len(np.unique(d['ri'])),mirror_fraction=mirrors/mirrorn if mirrorn else None,
        selected_probability_model=chosen['name'],probability=prob,coverage=coverage,baseline=baseline,
        limitations=['Maker touch/cross opportunities are not maker fills.','Source clocks are BAPI recorder receive-time proxies.',
        'Top three levels and 120ms retained observations; no unseen depth assumed.','Sep 7-9 influenced prior design; only Sep 10 is a new chronological test for this fit.',
        'Calibration is for market states on a ten-second grid, not validated for endogenous adaptive inventories.',
        'No fitted joint execution model or optimized inventory controller is established by quote targets.'])
    save('summary.json',summary)
    f=lambda x,dec=4:'N/A' if x is None else f'{x:.{dec}f}'
    lines=['# Wallet3048: BAPI inventory calibration, September 3–10, 2026','',
      f'Frozen range: **September 3, 00:00 through September 10, 10:40 Europe/Berlin**. UTC: `{PLAN["from"]}` to `{PLAN["toExclusive"]}` (exclusive).',
      '',f'**{total:,}/{len(manifest["rows"]):,} rounds passed the coverage rules.** The retained feeds represent {rawframes:,} raw BAPI book frames; {len(d["y"]):,} eligible state observations were used for calibration.',
      '',f'Outcome model selected on September 6: **{chosen["name"]}**. Training used September 3–5 only. September 7–9 is a retrospective comparison because its aggregate results already influenced the design. September 10 is the new, partial-day chronological test.',
      '', '## Coverage','', '| Berlin date | Expected | Eligible | Early start missing | Early end | Gaps >6s | API errors |','|---|---:|---:|---:|---:|---:|---:|']
    lines += [f'| {r["day"]} | {r["expected"]} | {r["eligible"]} | {r["early_start_missing"]} | {r["early_end"]} | {r["gaps_over_six_seconds"]} | {r["errors"]} |' for r in coverage]
    lines += ['', 'Exclusion reasons can overlap. Primary rules were frozen before fitting: first frame within two seconds, last at/after t+298s, no gap over six seconds, required clock fields, and a resolved BAPI winner. State observations additionally require fresh books/Binance and usable reference values.',
      '', '## Outcome-probability calibration','', '| Period | Feature rounds | Raw midpoint Brier | Selected Brier | Selected minus raw, 95% block interval |','|---|---:|---:|---:|---|']
    for label in SPLITS:
        q=prob[label][chosen['name']];base=prob[label]['market-midpoint'];delta=prob[label]['selected_minus_market_brier']
        lines.append(f'| {label} | {q["rounds"]} | {f(base["brier"])} | {f(q["brier"])} | {f(delta["mean"])} [{f(delta["ci"][0])}, {f(delta["ci"][1])}] |')
    lines += ['', 'Lower Brier score is better. Each round has equal total weight within a metric; repeated state observations are not treated as independent outcomes. Intervals use 1,000 circular block resamples of 12 consecutive available rounds, approximately one hour when coverage is uninterrupted. Short periods and missing rounds limit these intervals.',
      '', '![Calibration by chronological test period](probability-calibration.png)',
      '', 'Model coefficients, training-only standardization and validation selection scores are in [selected-probability-model.json](selected-probability-model.json). Features use first-observed in-round reference/Binance values; finalized opening metadata is excluded from model inputs. These observed opening proxies can differ from the contract opening value. The labels are BAPI final winners.',
      '', '## Best-ask price forecasts','', '| Horizon | Selected on validation | Retrospective MAE, cents | Latest-test MAE, cents | Latest persistence MAE, cents |','|---|---|---:|---:|---:|']
    for m in pm:
        h=m['horizon'];get=lambda split_,name:next(r['mae_cents'] for r in price if r['split']==split_ and r['horizon_seconds']==h and r['model']==name)
        lines.append(f'| {h}s | {m["selected"]} | {f(get("retrospective_test",m["selected"]),2)} | {f(get("latest_test",m["selected"]),2)} | {f(get("latest_test","persistence"),2)} |')
    lines += ['', 'The forecasts estimate future observed best asks, averaged over the two outcomes. They do not predict a filled order or price impact. Simple three-second velocity extrapolation and persistence were evaluated alongside fitted ridge changes. Full comparisons are in [price-forecast-metrics.csv](price-forecast-metrics.csv).',
      '', 'Weighted 5th/95th percentile forecast errors from September 6 define nominal 90% marginal price bands. [price-forecast-intervals.csv](price-forecast-intervals.csv) measures their later coverage, joint two-side coverage and width. These empirical bands can lose coverage when market conditions change; they are not guaranteed joint path bounds.',
      '', '## Joint price opportunities and maker limits','', '| Period, 30s / one-cent offset | UP touch | DOWN touch | Both touches | Product of marginal frequencies |','|---|---:|---:|---:|---:|']
    for label in SPLITS:
        r=next(r for r in jrows if r['split']==label and r['horizon_seconds']==30 and r['offset']==.01)
        lines.append(f'| {label} | {f(100*r["up_touch"],2)}% | {f(100*r["down_touch"],2)}% | {f(100*r["both_touch"],2)}% | {f(100*r["empirical_independence_product"],2)}% |')
    lines += ['', '| Period | Joint-touch model Brier | Independence model Brier | Joint minus independence, 95% block interval |',
              '|---|---:|---:|---|']
    for label in SPLITS:
        r=jr[label];delta=r['joint_minus_independence_brier']
        lines.append(f'| {label} | {f(r["joint_model"]["brier"])} | {f(r["independence_model"]["brier"])} | {f(delta["mean"])} [{f(delta["ci"][0])}, {f(delta["ci"][1])}] |')
    lines += ['', 'A touch means the future best ask reached its decision-time best ask minus the selected offset, at or after modeled 520ms arrival and before the stated horizon. Both touches may occur at different times. Horizons extending beyond t+298s are omitted. Deeper offsets are hypothetical future price targets, not permission to submit deeper bids under the fixed maker rule.',
      '', 'The one-cent offset is a controlled research probe. Historical tick-size/minimum-order metadata is absent from these frame responses, so it does not establish the exact best-ask-minus-current-tick placement for every historical market state.',
      '', '**These are price opportunities, not completed pairs or maker fill rates.** The two touch events are measured jointly. A separate fitted joint-touch model and an independence-product comparison are in [joint-price-results.json](joint-price-results.json); neither supplies queue position, trade flow or actual fill quantities.',
      '', '| Latest-test 520ms arrival | Would reject ask-minus-one-cent post-only | Ask moved beyond a +1-cent taker cap |','|---|---:|---:|']
    for r in arrival:
        if r['split']=='latest_test':lines.append(f'| {r["side"]} | {f(100*r["post_only_rejection_rate"],2)}% | {f(100*r["ask_over_plus_one_tick_rate"],2)}% |')
    lines += ['', f'Complementary Up-ask/Down-bid and Up-bid/Down-ask price/size matches account for {f(100*summary["mirror_fraction"],2)}% of checked top-three levels. This is a book-structure observation, not independent evidence from two markets.',
      '', 'The observed BAPI frame schema contains books, spot values and receive clocks, with no trade IDs, aggressor-side trade flow, order acknowledgments or queue positions. `/trades`, `/market-trades` and `/openapi.json` probes on the configured V2 base returned 404. This does not prove no other BAPI service exposes flow; the supplied endpoints do not establish maker execution.',
      '', '## Current v5 complete-round P&L baseline','', '| Berlin date | Eligible / expected | Entry accuracy | Positive / negative | Avg win | Avg loss | Mean / eligible round | Net P&L |','|---|---:|---:|---:|---:|---:|---:|---:|']
    for r in baseline:
        if r['period'] in SPLITS:continue
        lines.append(f'| {r["period"]} | {r["eligible"]}/{r["expected"]} | {f(100*r["entry_accuracy"],2) if r["entry_accuracy"] is not None else "N/A"}% | {r["profitable"]}/{r["losing"]} | ${f(r["avg_win"],2)} | ${f(r["avg_loss"],2)} | ${f(r["mean_per_eligible"],2)} | ${f(r["net_pnl"],2)} |')
    lines += ['', 'These are historical simulations of unchanged v5, not executions of the proposed inventory controller. They use 520ms arrival latency, strict-no-maker, modeled fees, independent rounds and the frozen runtime parameters. Identical prior September 7–9 replay results were reused where source/configuration hashes matched. The stricter gap exclusion can change their earlier daily aggregates. Baseline entry accuracy comes from first positive fills; probability-model accuracy is a separate state-grid metric.',
      '', '## What can be calibrated from these data','',
      '- Outcome probabilities, conditional best-ask changes, latency price movement and joint target-touch frequencies can be estimated and evaluated chronologically.',
      '- The sizing equations can consume these prices, but a target-touch probability cannot stand in for probability of acquiring the required shares.',
      '- Actual maker fill quantities and cancellation races remain unverified. Consequently, a fitted complete joint execution model, optimal H/DIFF targets, and profitable full inventory policy are not established by this study.',
      '- Loss weight is a return/downside preference. Choose and evaluate it with a defensible execution model; these forecast scores do not determine a universal loss weight or guarantee average wins exceed average losses.',
      '- No runtime strategy parameters were changed. The calibrated models are research artifacts for further simulation; no live orders were submitted.',
      '', '## Reproduction and provenance','',
      'The immutable window list/splits and original code hashes are in [study-plan.json](study-plan.json). [manifest.json](manifest.json) records feed hashes, reused-cache provenance, raw page counts, coverage and exclusions. Collector, feature/model scripts and focused causality tests are under `research/wallet-3048/`.',
      '', '```bash','node research/wallet-3048/calibrate-inventory-data.mjs','node research/wallet-3048/calibrate-inventory-baseline.mjs',
      'python research/wallet-3048/inventory_calibration_features_test.py','python research/wallet-3048/calibrate_inventory.py','```',
      '', 'Python dependencies: NumPy, SciPy, scikit-learn and Matplotlib. Exact installed versions are recorded in [verification.json](verification.json). Collection resumes from the frozen range and existing files. Use a new output directory and an explicitly revised study plan for a later cutoff rather than silently extending this test cohort.']
    (OUT/'report.md').write_text('\n'.join(lines)+'\n')
    import scipy,sklearn
    save('verification.json',dict(pythonDependencies=dict(numpy=np.__version__,scipy=scipy.__version__,sklearn=sklearn.__version__,matplotlib=matplotlib.__version__),
        unique_manifest_rounds=len(set(r['slug'] for r in manifest['rows'])),manifest_rounds=len(manifest['rows']),
        feature_rows=len(d['y']),featureHash=FEATURE_HASH,feature_future_mutation_test='passed separately',
        modelInputsExcludeFinalWinnerAndFinalOpeningMetadata=True,trainingSplit=0,validationSplit=1,
        makerFillsCreditedByCalibration=0,productionChanged=False))
    print(json.dumps(dict(phase='report-complete',file=str(OUT/'report.md'))),flush=True)


if __name__=='__main__':
    d=extract()
    if not args.extract_only:
        save('calibration-code-lock.json',dict(frozenBeforeFitting=time.time(),
            files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),Path(__file__).with_name('inventory_calibration_features.py')]},
            studyPlanSha256=hashlib.sha256((OUT/'study-plan.json').read_bytes()).hexdigest()))
        chosen,prob=probability(d);pm,price=prices(d);jr,jrows,arrival=joint(d)
        baseline=baseline_report();report(d,chosen,prob,pm,price,jr,jrows,arrival,baseline)

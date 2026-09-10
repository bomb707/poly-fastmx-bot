import copy
import unittest
import numpy as np
from inventory_calibration_features import prepare, causal_features, asof


class CausalityTests(unittest.TestCase):
    def fixture(self):
        ticks=[]
        for k in range(301):
            t=k/10
            price=.50+.002*t
            book=lambda ask: dict(bestAsk=ask,bestBid=ask-.01,asks=[[ask,100]],bids=[[ask-.01,100]],depthTs=t*1000)
            ticks.append(dict(t=t,ms=t*1000,bz=10000+t,cl=10000+t/2,
                upAsk=price,upBid=price-.01,dnAsk=1.01-price,dnBid=1-price,
                binanceAtMs=t*1000,chainlinkAtMs=t*1000,up=book(price),down=book(1.01-price)))
        return dict(windowStart=0,ticks=ticks,winSide='Up',openPrice=9000,openBinance=9000)

    def test_asof_never_selects_future(self):
        self.assertEqual(asof(np.array([.1,.4,.6]),.52),1)
        self.assertEqual(asof(np.array([.1,.4,.6]),.05),-1)

    def test_future_and_final_metadata_do_not_change_features(self):
        d=self.fixture();f=causal_features(prepare(d),10)
        self.assertIsNotNone(f)
        d2=copy.deepcopy(d);d2.update(winSide='Down',openPrice=20000,openBinance=20000)
        for tick in d2['ticks']:
            if tick['t']>10:
                for k in ['bz','cl','upAsk','dnAsk','upBid','dnBid']:tick[k]*=.5
        g=causal_features(prepare(d2),10)
        np.testing.assert_array_equal(f[0],g[0])
        self.assertEqual(f[1],g[1])

    def test_missing_and_future_clocks_rejected(self):
        d=self.fixture();d['ticks'][100]['binanceAtMs']=None
        self.assertIsNone(causal_features(prepare(d),10))
        d=self.fixture();d['ticks'][100]['up']['depthTs']=10002
        self.assertIsNone(causal_features(prepare(d),10))


if __name__=='__main__':unittest.main()

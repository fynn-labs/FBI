package main

import (
	"reflect"
	"sort"
	"testing"
)

func sortPairs(p []Mapping) []Mapping {
	cp := append([]Mapping(nil), p...)
	sort.Slice(cp, func(i, j int) bool { return cp[i].Remote < cp[j].Remote })
	return cp
}

func TestMerge_discoveryOnly(t *testing.T) {
	got := mergeMappings([]int{5173, 9229}, nil)
	want := []Mapping{{Local: 5173, Remote: 5173}, {Local: 9229, Remote: 9229}}
	if !reflect.DeepEqual(sortPairs(got), want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestMerge_overrideWins(t *testing.T) {
	got := mergeMappings(
		[]int{5173, 9229},
		[]Override{{Local: 8080, Remote: 5173}},
	)
	want := []Mapping{{Local: 8080, Remote: 5173}, {Local: 9229, Remote: 9229}}
	if !reflect.DeepEqual(sortPairs(got), want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestMerge_overrideAdds(t *testing.T) {
	got := mergeMappings(
		[]int{5173},
		[]Override{{Local: 9000, Remote: 9000}},
	)
	want := []Mapping{{Local: 5173, Remote: 5173}, {Local: 9000, Remote: 9000}}
	if !reflect.DeepEqual(sortPairs(got), want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

func TestMerge_overridesOnlyWhenNoDiscovery(t *testing.T) {
	got := mergeMappings(nil, []Override{{Local: 5173, Remote: 5173}})
	want := []Mapping{{Local: 5173, Remote: 5173}}
	if !reflect.DeepEqual(sortPairs(got), want) {
		t.Errorf("got %+v want %+v", got, want)
	}
}

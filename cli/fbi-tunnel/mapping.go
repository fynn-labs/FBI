package main

type Mapping struct {
	Local  int
	Remote int
}

func mergeMappings(discovered []int, overrides []Override) []Mapping {
	byRemote := make(map[int]int) // remote -> local
	for _, p := range discovered {
		byRemote[p] = p
	}
	for _, o := range overrides {
		byRemote[o.Remote] = o.Local
	}
	out := make([]Mapping, 0, len(byRemote))
	for remote, local := range byRemote {
		out = append(out, Mapping{Local: local, Remote: remote})
	}
	return out
}
